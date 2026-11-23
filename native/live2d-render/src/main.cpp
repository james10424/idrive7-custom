/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 James Zhao */
/* live2d-render: draws a Live2D model on the head unit's GPU with the
 * parameter values an app sends, and shows it as a cluster-render video layer
 * (README.md). One app at a time; the model goes when the app disconnects.
 *
 *   live2d-render [--socket PATH] [--sdk DIR] [--state DIR] [--cluster-socket PATH]
 *                 [--software] [--stdout] [--idle-exit S] [--display-wait S]
 *
 * --display-wait (30): no frames until the KOMBI's display service has been up
 * this long (cluster-render's status), counted again after it goes away; 0 off.
 * At a car start the KOMBI took her scene and then hung 10 s into her frames,
 * taking its link to the head unit down with it (Nov 15 2026).
 *
 * --software draws with Mesa's software renderer and --stdout writes the 4:2:0
 * frames to stdout instead of cluster-render: for trying it off the car. */
#include <dlfcn.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <cstdint>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <algorithm>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "cluster_render/client.h"
#include "control.h"
#include "glue_api.h"
#include "gpu.h"
#include "guard.h"

namespace {

volatile sig_atomic_t g_stop = 0;

int64_t now_ms()
{
    timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
double now_fms()
{
    timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

std::string fmt(const char *f, double v)
{
    char b[64];
    snprintf(b, sizeof b, f, v);
    return b;
}

/* The glue library's functions (glue_api.h), found with dlsym. */
struct Glue {
    void *lib = nullptr;
    int (*api)();
    const char *(*error)();
    l2d_model *(*open)(const char *, unsigned, unsigned, unsigned);
    void (*close)(l2d_model *);
    int (*param_count)(const l2d_model *);
    const char *(*param_id)(const l2d_model *, int);
    float (*param_default)(const l2d_model *, int);
    int (*part_index)(const l2d_model *, const char *);
    void (*update)(l2d_model *, const float *, const int *, const float *, int, float, double *, double *);
    void (*draw)(l2d_model *, const float *);
    void (*blend)(l2d_model *, int, float) = nullptr;   /* optional: an older glue hasn't it */
    void (*gpu_bytes)(const l2d_model *, long long *) = nullptr;   /* optional too */
    void (*set_wind)(l2d_model *, float, float) = nullptr;         /* optional too */
    int (*set_wind_params)(l2d_model *, const char *) = nullptr;   /* optional too */

    bool load(const std::string &path, std::string *err)
    {
        if (lib) return true;
        void *h = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
        if (!h) {
            *err = std::string("no Cubism glue library (README.md \"The Cubism SDK\"): ") + dlerror();
            return false;
        }
        bool ok = true;
        auto sym = [&](const char *name) {
            void *p = dlsym(h, name);
            if (!p) ok = false;
            return p;
        };
        api = (int (*)())sym("l2d_api");
        error = (const char *(*)())sym("l2d_error");
        open = (l2d_model * (*)(const char *, unsigned, unsigned, unsigned)) sym("l2d_open");
        close = (void (*)(l2d_model *))sym("l2d_close");
        param_count = (int (*)(const l2d_model *))sym("l2d_param_count");
        param_id = (const char *(*)(const l2d_model *, int))sym("l2d_param_id");
        param_default = (float (*)(const l2d_model *, int))sym("l2d_param_default");
        part_index = (int (*)(const l2d_model *, const char *))sym("l2d_part_index");
        update = (void (*)(l2d_model *, const float *, const int *, const float *, int, float, double *, double *))sym(
            "l2d_update");
        draw = (void (*)(l2d_model *, const float *))sym("l2d_draw");
        blend = (void (*)(l2d_model *, int, float))dlsym(h, "l2d_blend");
        gpu_bytes = (void (*)(const l2d_model *, long long *))dlsym(h, "l2d_gpu_bytes");
        set_wind = (void (*)(l2d_model *, float, float))dlsym(h, "l2d_set_wind");
        set_wind_params = (int (*)(l2d_model *, const char *))dlsym(h, "l2d_set_wind_params");
        if (!ok || api() != L2D_API) {
            *err = ok ? "the Cubism glue library is for another live2d-render (rebuild it: make glue)"
                      : "the Cubism glue library lacks a function (rebuild it: make glue)";
            dlclose(h);
            return false;
        }
        lib = h;
        return true;
    }
};

struct Options {
    std::string socket = "/dev/shm/live2d-render/render.sock";
    std::string sdk = "/var/opt/live2d-render/sdk";
    std::string state = "/var/opt/live2d-render/state";
    std::string cluster_socket = cr::kDefaultSocket;
    bool software = false, to_stdout = false, check = false;
    int idle_exit_s = 60;
    int display_wait_s = 30;
};

class Service {
public:
    explicit Service(const Options &o) : opt_(o), guard_(o.state) {}

    int run(int listen_fd, bool activated);

private:
    Options opt_;
    l2r::Guard guard_;
    Glue glue_;
    std::unique_ptr<l2r::Gpu> gpu_;
    std::unique_ptr<cr::Client> cr_;
    int client_ = -1;
    std::string inbuf_;

    /* the open model */
    l2d_model *model_ = nullptr;
    l2r::OpenRequest req_;
    l2r::Params params_;
    std::vector<int> hide_idx_;
    std::vector<float> hide_op_;
    float mvp_[16];
    float offset_x_ = 0, offset_y_ = 0;   /* "offset": px the model is moved in the picture */
    float wind_x_ = 0, wind_y_ = 0;       /* "wind": on the model's physics (glue l2d_set_wind) */
    std::string wind_params_;             /* "wind" params: the parameters it moves, as set on this model */
    bool wind_told_ = false;              /* "the glue has no wind" logged */
    uint32_t ref_ = 0;
    cr::LayerOptions lo_;
    bool visible_ = true;
    /* the KOMBI's display service: up since (-1 not up), and its status asked or answered last */
    /* kNotUp: not up. A time, not a sign: up longer than this process's clock has run is below 0 */
    static const int64_t kNotUp = INT64_MIN, kLongAgo = INT64_MIN / 2;
    int64_t display_since_ = kNotUp;
    bool display_known_ = false, display_held_ = false;
    int64_t status_asked_ = 0, status_answered_ = 0, opened_at_ = 0;
    double next_ = 0;   /* when the next frame is due (now_fms); on a grid of 1000 / fps ms, not whole ms */
    double last_update_ = 0;
    unsigned core_phase_ = 0;   /* frames since Core last ran (core > 1) */
    uint64_t frame_id_ = 1;
    std::vector<uint8_t> atlas_;
    /* timing over the last stats window */
    int64_t stats_at_ = 0;
    int frames_ = 0, ticks_ = 0;   /* frames sent, frames drawn */
    double pending_at_ = 0;        /* when the frame the GPU has was handed to it */
    double s_update_ = 0, s_draw_ = 0, s_read_ = 0, s_physics_ = 0, s_core_ = 0;

    void send(const std::string &json);
    void reply_error(const std::string &op, const std::string &reason);
    void drop_client();
    void handle(const std::string &line);
    void open_model(const cr::Json &m);
    void close_model();
    void draw_frame();
    bool collect(double now);
    void stats(int64_t now);
    bool display_ready(int64_t now);
};

void Service::send(const std::string &json)
{
    if (client_ < 0) return;
    std::string line = json + "\n";
    /* small and rare (replies, states, stats): written whole, or the client is gone */
    size_t done = 0;
    while (done < line.size()) {
        ssize_t k = ::send(client_, line.data() + done, line.size() - done, MSG_NOSIGNAL);
        if (k < 0 && errno == EINTR) continue;
        if (k <= 0) { drop_client(); return; }
        done += (size_t)k;
    }
}

void Service::reply_error(const std::string &op, const std::string &reason)
{
    fprintf(stderr, "live2d-render: %s: %s\n", op.c_str(), reason.c_str());
    send(cr::json_object({{"t", "\"error\""}, {"op", cr::json_quote(op)}, {"reason", cr::json_quote(reason)}}));
}

void Service::drop_client()
{
    if (client_ >= 0) close(client_);
    client_ = -1;
    inbuf_.clear();
    close_model();
}

void Service::close_model()
{
    if (cr_ && ref_) cr_->drop(ref_);
    ref_ = 0;
    if (gpu_) gpu_->atlas_drop();
    if (model_) glue_.close(model_);
    model_ = nullptr;
    guard_.end();
}

void Service::open_model(const cr::Json &m)
{
    close_model();
    l2r::OpenRequest r;
    std::string err;
    if (!l2r::parse_open(m, &r, &err)) return reply_error("open", err);
    if (!guard_.refusal().empty()) return reply_error("open", guard_.refusal());
    if (!glue_.load(opt_.sdk + "/liblive2d-glue.so", &err)) return reply_error("open", err);
    if (!gpu_) {
        std::unique_ptr<l2r::Gpu> g(new l2r::Gpu());
        if (!g->init(opt_.software, &err)) return reply_error("open", err);
        fprintf(stderr, "live2d-render: OpenGL ES %s\n", g->renderer().c_str());
        gpu_ = std::move(g);
    }
    if (!gpu_->size(r.w, r.h, &err)) return reply_error("open", err);
    const double t0 = now_fms();
    guard_.begin();   /* from here on the GPU is ours: a fault in loading counts too */
    model_ = glue_.open(r.model.c_str(), r.w, r.h, r.masks);
    if (!model_) {
        guard_.end();
        return reply_error("open", glue_.error());
    }
    std::vector<std::string> ids;
    std::vector<float> defaults;
    for (int i = 0; i < glue_.param_count(model_); i++) {
        ids.push_back(glue_.param_id(model_, i));
        defaults.push_back(glue_.param_default(model_, i));
    }
    params_.reset(ids, defaults);
    wind_x_ = wind_y_ = 0;   /* a new model starts calm, as the app's next "wind" says */
    wind_params_.clear();     /* and with the wind on all of its physics until the app names the parameters */
    std::vector<std::string> unknown_ids;
    if (m.count("v") && params_.apply(m.at("v"), &unknown_ids) < 0) {
        glue_.close(model_);
        model_ = nullptr;
        guard_.end();
        return reply_error("open", "v: \"Id=value Id=value ...\"");
    }
    hide_idx_.clear();
    hide_op_.clear();
    std::vector<std::string> missing;
    for (const std::string &p : r.hide) {
        int i = glue_.part_index(model_, p.c_str());
        if (i < 0) missing.push_back(p);
        hide_idx_.push_back(i);
        hide_op_.push_back(0.0f);
    }
    l2r::frame_mvp(r.cx, r.cy, r.height, r.w, r.h, mvp_);
    offset_x_ = offset_y_ = 0;
    req_ = r;
    visible_ = r.visible;
    if (!opt_.to_stdout) {
        if (!cr_) {
            cr_.reset(new cr::Client("live2d-render", opt_.cluster_socket));
            cr_->on_layer = [this](uint32_t ref, const std::string &state, const std::string &why) {
                if (ref != ref_) return;
                send(cr::json_object({{"t", "\"layer\""}, {"state", cr::json_quote(state)}, {"reason", cr::json_quote(why)}}));
            };
            cr_->on_status = [this](const std::string &text) {
                const int up = l2r::display_up_s(text);
                const int64_t now = now_ms();
                status_answered_ = now;
                display_known_ = true;
                if (up == -2) display_since_ = kLongAgo;   /* no display service line: not a car, nothing to wait for */
                else if (up < 0) display_since_ = kNotUp;
                else if (display_since_ == kNotUp || display_since_ == kLongAgo || std::llabs(display_since_ - (now - up * 1000LL)) > 3000)
                    display_since_ = now - up * 1000LL;
            };
            cr_->on_target = [this](const std::string &target, const std::string &state, const std::string &,
                                    const std::string &) {
                if (target == req_.target && state == "unavailable") display_since_ = kNotUp;
            };
            cr_->on_error = [this](const std::string &op, uint32_t ref, const std::string &why) {
                if (ref && ref != ref_) return;
                reply_error("cluster-render " + op, why);
            };
        }
        lo_ = cr::LayerOptions();
        lo_.target = r.target;
        lo_.klass = r.klass;
        lo_.x = r.x;
        lo_.y = r.y;
        lo_.z = r.z;
        lo_.w = r.w;
        lo_.h = r.h;
        lo_.visible = r.visible;
        cr::VideoOptions vo;
        vo.w = r.w;
        vo.h = r.h;
        vo.fps = r.fps;
        ref_ = cr_->video(lo_, vo);
    }
    next_ = now_fms();
    opened_at_ = now_ms();
    status_asked_ = 0;
    display_known_ = false;   /* asked again: the KOMBI may have restarted since the last model */
    display_held_ = false;
    last_update_ = 0;
    core_phase_ = 0;
    stats_at_ = opened_at_;
    frames_ = ticks_ = 0;
    s_update_ = s_draw_ = s_read_ = s_physics_ = s_core_ = 0;
    const double ms = now_fms() - t0;
    fprintf(stderr, "live2d-render: opened %s (%d parameters) in %.0f ms\n", r.model.c_str(), (int)ids.size(), ms);
    std::vector<std::pair<std::string, std::string>> kv = {{"t", "\"opened\""},
                                                           {"params", fmt("%.0f", (double)ids.size())},
                                                           {"ms", fmt("%.0f", ms)},
                                                           {"gl", cr::json_quote(gpu_->renderer())}};
    {
        /* her GPU memory: the model's (the glue's count) and the picture's (its RGBA target, the 4:2:0 planes'
         * targets, w/4 x h and w/4 x h/2 RGBA, and the read buffer, w x h x 1.5) */
        long long g[3] = {0, 0, 0};
        if (glue_.gpu_bytes) glue_.gpu_bytes(model_, g);
        const long long picture = (long long)r.w * r.h * 7;
        const double mib = 1024.0 * 1024.0;
        fprintf(stderr, "live2d-render: GPU memory %.1f MiB (textures %.1f, masks %.1f, buffers %.1f, picture %.1f)%s\n",
                (g[0] + g[1] + g[2] + picture) / mib, g[0] / mib, g[1] / mib, g[2] / mib, picture / mib,
                glue_.gpu_bytes ? "" : "; the glue doesn't count the model's (make glue)");
        kv.push_back({"gpu_bytes", fmt("%.0f", (double)(g[0] + g[1] + g[2] + picture))});
    }
    {
        /* every parameter's default, for the app's rest pose */
        std::string list;
        char b[32];
        for (size_t i = 0; i < ids.size(); i++) {
            snprintf(b, sizeof b, "=%g", defaults[i]);
            list += (i ? " " : "") + ids[i] + b;
        }
        kv.push_back({"defaults", cr::json_quote(list)});
    }
    if (!unknown_ids.empty()) {
        std::string list;
        for (const std::string &u : unknown_ids) list += (list.empty() ? "" : ",") + u;
        kv.push_back({"unknown", cr::json_quote(list)});
    }
    if (!missing.empty()) {
        std::string list;
        for (const std::string &p : missing) list += (list.empty() ? "" : ",") + p;
        kv.push_back({"missing_parts", cr::json_quote(list)});
    }
    send(cr::json_object(kv));
}

void Service::handle(const std::string &line)
{
    cr::Json m;
    if (!cr::parse_json(line, &m)) return reply_error("message", "not a flat JSON object");
    const std::string t = m.count("t") ? m["t"] : "";
    if (t == "open") return open_model(m);
    if (t == "p") {
        if (m.count("reset") && m["reset"] == "1") params_.to_defaults();
        std::vector<std::string> unknown;
        if (params_.apply(m.count("v") ? m["v"] : "", &unknown) < 0) return reply_error("p", "v: \"Id=value Id=value ...\"");
        if (!unknown.empty()) {
            std::string list;
            for (const std::string &u : unknown) list += (list.empty() ? "" : ",") + u;
            send(cr::json_object({{"t", "\"unknown\""}, {"ids", cr::json_quote(list)}}));
        }
        return;
    }
    if (t == "show" || t == "hide") {
        visible_ = t == "show";
        if (visible_) next_ = now_fms();
        if (cr_ && ref_) {
            lo_.visible = visible_;
            cr_->set(ref_, lo_);
        }
        return;
    }
    if (t == "move") {
        double v;
        auto get = [&](const char *k, int *out) {
            if (m.count(k)) { v = atof(m[k].c_str()); *out = (int)v; }
        };
        get("x", &lo_.x);
        get("y", &lo_.y);
        get("z", &lo_.z);
        if (cr_ && ref_) cr_->set(ref_, lo_);
        return;
    }
    if (t == "offset") {
        /* the model moved inside its picture (px, fractions too): an app's bounce; at most a quarter of the
         * picture each way */
        auto get = [&](const char *k, float lim, float *out) {
            if (m.count(k)) {
                float v = (float)atof(m[k].c_str());
                *out = v > lim ? lim : v < -lim ? -lim : v;
            }
        };
        get("x", req_.w / 4.0f, &offset_x_);
        get("y", req_.h / 4.0f, &offset_y_);
        return;
    }
    if (t == "close") return close_model();
    if (t == "wind") {
        /* the wind on her physics (hair, ribbons): x right, y up, gravity 1 down; at most 2 either way */
        auto get = [&](const char *k, float *out) {
            if (m.count(k)) {
                float v = (float)atof(m[k].c_str());
                *out = v > 2 ? 2 : v < -2 ? -2 : v;
            }
        };
        get("x", &wind_x_);
        get("y", &wind_y_);
        /* "params": the parameters the wind moves (her hair, ribbons), once per model; the rest stay calm */
        if (model_ && m.count("params") && m["params"] != wind_params_) {
            wind_params_ = m["params"];
            if (glue_.set_wind_params) {
                const int found = glue_.set_wind_params(model_, wind_params_.c_str());
                fprintf(stderr, "live2d-render: the wind moves %d of the parameters named\n", found);
            } else {
                fprintf(stderr, "live2d-render: the Cubism glue can't limit the wind to parameters (make glue, make deploy-sdk)\n");
            }
        }
        if (!glue_.set_wind) {
            if (!wind_told_) fprintf(stderr, "live2d-render: the Cubism glue has no wind (make glue, make deploy-sdk)\n");
            wind_told_ = true;
            return;
        }
        if (model_) glue_.set_wind(model_, wind_x_, wind_y_);
        return;
    }
    if (t == "restart") {
        /* the owner's reset from an app's menu: the crash guard's file and count go, then live2d-render exits;
         * systemd's socket starts it again at the app's next connect (a few seconds) */
        close_model();
        guard_.reset();
        fprintf(stderr, "live2d-render: restart asked: crash guard cleared, exiting\n");
        send(cr::json_object({{"t", "\"restarting\""}}));
        g_stop = 1;
        return;
    }
    reply_error("message", "unknown t \"" + t + "\"");
}

/* The frame the GPU drew last tick: read, checked, sent. Dropped when it is old (she was held or hidden since). */
bool Service::collect(double now)
{
    const bool stale = now - pending_at_ > 3000.0 / (req_.fps ? req_.fps : 15);
    std::string err;
    if (stale) {
        gpu_->atlas_drop();
        return true;
    }
    if (!gpu_->atlas_done(&atlas_, &err)) {
        reply_error("draw", err + ": stopped drawing");
        close_model();
        return false;
    }
    if (opt_.check) {
        /* the GPU's atlas against the CPU's, from the same picture (not drawn over yet) */
        std::vector<uint8_t> rgba, ref(atlas_.size());
        gpu_->picture(&rgba);
        l2r::yuv420_reference(rgba.data(), req_.w, req_.h, ref.data());
        size_t off = 0;
        int worst = 0;
        for (size_t i = 0; i < ref.size(); i++) {
            int d = abs((int)ref[i] - (int)atlas_[i]);
            off += d != 0;
            worst = d > worst ? d : worst;
        }
        fprintf(stderr, "check: frame %llu: %zu of %zu bytes differ (by %d at most)\n", (unsigned long long)frame_id_,
                off, ref.size(), worst);
        if (opt_.to_stdout) frame_id_++;
    }
    if (opt_.to_stdout) {
        size_t done = 0;
        while (done < atlas_.size()) {
            ssize_t k = write(1, atlas_.data() + done, atlas_.size() - done);
            if (k <= 0) { g_stop = 1; return false; }
            done += (size_t)k;
        }
    } else if (cr_ && ref_) {
        cr_->frame(ref_, &atlas_, frame_id_++);
    }
    frames_++;
    return true;
}

/* Two frames in flight: this tick works out frame N on the CPU, collects N-1 (the GPU drew it meanwhile), then
 * hands N to the GPU and returns without waiting. Frames reach the cluster one tick later. */
void Service::draw_frame()
{
    const double a0 = now_fms();
    /* Core on every core-th frame (the open's core, when the glue can blend): its pose, then the frames up to the
     * next show the way from the pose before to it, the last of them it exactly. A frame later than Core every
     * frame, by core - 1 frames. After a gap (held, hidden) the new pose shows at once. */
    const unsigned every = glue_.blend ? req_.core : 1;
    const double period = 1000.0 / (req_.fps ? req_.fps : 15);
    const bool gap = last_update_ > 0 && a0 - last_update_ > 3.0 * period * every;
    if (gap) core_phase_ = 0;
    double ph = 0, co = 0;
    if (core_phase_ == 0) {
        const float dt = last_update_ > 0 ? (float)((a0 - last_update_) / 1000.0) : 1.0f / req_.fps;
        last_update_ = a0;
        glue_.update(model_, params_.values().data(), hide_idx_.data(), hide_op_.data(), (int)hide_idx_.size(),
                     dt > 0.2f ? 0.2f : dt, &ph, &co);
    }
    if (every > 1) glue_.blend(model_, core_phase_ == 0, gap ? 1.0f : (float)(core_phase_ + 1) / every);
    core_phase_ = (core_phase_ + 1) % every;
    const double a1 = now_fms();
    if (gpu_->atlas_pending() && !collect(a1)) return;
    const double a2 = now_fms();
    gpu_->begin();
    float mvp[16];
    l2r::offset_mvp(mvp_, offset_x_, offset_y_, req_.w, req_.h, mvp);
    glue_.draw(model_, mvp);
    std::string err;
    if (!gpu_->atlas_start(&err)) {
        reply_error("draw", err + ": stopped drawing");
        close_model();
        return;
    }
    pending_at_ = now_fms();
    const double a3 = pending_at_;
    ticks_++;
    s_update_ += a1 - a0;
    s_read_ += a2 - a1;
    s_draw_ += a3 - a2;
    s_physics_ += ph;
    s_core_ += co;
}

void Service::stats(int64_t now)
{
    if (!model_ || now - stats_at_ < 5000) return;
    const double n = ticks_ ? ticks_ : 1, secs = (now - stats_at_) / 1000.0;
    const double work = (s_update_ + s_draw_ + s_read_) / n, busy = 100.0 * work * req_.fps / 1000.0;
    fprintf(stderr, "live2d-render: %.1f fps, update %.2f ms (physics %.2f, Core %.2f), draw %.2f ms, read %.2f ms; "
                    "%.0f%% of a %.0f ms frame\n",
            frames_ / secs, s_update_ / n, s_physics_ / n, s_core_ / n, s_draw_ / n, s_read_ / n, busy,
            1000.0 / req_.fps);
    send(cr::json_object({{"t", "\"stats\""},
                          {"fps", fmt("%.1f", frames_ / secs)},
                          {"update", fmt("%.2f", s_update_ / n)},
                          {"draw", fmt("%.2f", s_draw_ / n)},
                          {"read", fmt("%.2f", s_read_ / n)},
                          {"busy", fmt("%.0f", busy)}}));
    stats_at_ = now;
    frames_ = ticks_ = 0;
    s_update_ = s_draw_ = s_read_ = s_physics_ = s_core_ = 0;
}

bool Service::display_ready(int64_t now)
{
    if (!cr_ || opt_.display_wait_s <= 0) return true;
    /* asked every second while a model is open: a KOMBI that goes away stops her frames within it */
    if (now - status_asked_ >= 1000) {
        status_asked_ = now;
        cr_->request_status();
    }
    /* a cluster-render that never answers isn't waited for */
    if (!display_known_ && now - opened_at_ > 10000) {
        display_known_ = true;
        display_since_ = kLongAgo;
        fprintf(stderr, "live2d-render: cluster-render doesn't say how long the display has been up: drawing\n");
    }
    const bool ready = display_known_ && display_since_ != kNotUp && now - display_since_ >= opt_.display_wait_s * 1000LL;
    if (ready == display_held_ && display_known_) {
        if (ready) {
            if (display_since_ != kLongAgo)
                fprintf(stderr, "live2d-render: the KOMBI's display has been up %lld s: drawing\n",
                        (long long)((now - display_since_) / 1000));
        } else if (display_since_ != kNotUp)
            fprintf(stderr, "live2d-render: the KOMBI's display has been up %lld s: her frames wait until %d s\n",
                    (long long)((now - display_since_) / 1000), opt_.display_wait_s);
        else
            fprintf(stderr, "live2d-render: the KOMBI's display isn't up: her frames wait until it has been for %d s\n",
                    opt_.display_wait_s);
        display_held_ = !ready;
    }
    return ready;
}

int Service::run(int listen_fd, bool activated)
{
    guard_.start();
    if (!guard_.refusal().empty()) fprintf(stderr, "live2d-render: %s\n", guard_.refusal().c_str());
    int64_t idle_since = now_ms();
    while (!g_stop) {
        const int64_t now = now_ms();
        const bool drawing = model_ && visible_ && display_ready(now);
        /* the crash guard's marker only while frames go to the GPU: when the display goes (the car switching off,
         * the KOMBI first) or she's hidden, it's removed, so a head unit that powers off after that isn't taken for
         * one that went down while she drew. Opening a model holds it too (open_model) */
        if (model_) {
            if (drawing) guard_.begin();
            else guard_.end();
        }
        int timeout = 250;
        if (drawing) {
            const double wait = next_ - now_fms();
            timeout = wait > 0 ? (int)std::min(std::ceil(wait), 250.0) : 0;
        }
        pollfd fds[3];
        int n = 0;
        fds[n++] = {listen_fd, POLLIN, 0};
        if (client_ >= 0) fds[n++] = {client_, POLLIN, 0};
        int crfd = cr_ ? cr_->fd() : -1;
        if (crfd >= 0) fds[n++] = {crfd, (short)(cr_->wants_write() ? POLLIN | POLLOUT : POLLIN), 0};
        if (poll(fds, n, timeout) < 0 && errno != EINTR) break;
        if (fds[0].revents & POLLIN) {
            int c = accept4(listen_fd, nullptr, nullptr, SOCK_CLOEXEC | SOCK_NONBLOCK);
            if (c >= 0) {
                if (client_ >= 0) {
                    fprintf(stderr, "live2d-render: a new app connected; the last one's model goes\n");
                    drop_client();
                }
                client_ = c;
            }
        }
        if (client_ >= 0 && n > 1 && fds[1].fd == client_ && (fds[1].revents & (POLLIN | POLLHUP | POLLERR))) {
            char buf[65536];
            ssize_t k = recv(client_, buf, sizeof buf, 0);
            if (k == 0 || (k < 0 && errno != EAGAIN && errno != EINTR)) {
                drop_client();
            } else if (k > 0) {
                inbuf_.append(buf, (size_t)k);
                size_t nl;
                while (client_ >= 0 && (nl = inbuf_.find('\n')) != std::string::npos) {
                    std::string line = inbuf_.substr(0, nl);
                    inbuf_.erase(0, nl + 1);
                    if (!line.empty()) handle(line);
                }
                if (inbuf_.size() > (1 << 20)) { reply_error("message", "a line over 1 MB"); drop_client(); }
            }
        }
        if (cr_) cr_->poll(now_ms());
        if (model_ && visible_ && !display_ready(now_ms())) {
            next_ = now_fms();
            stats_at_ = now_ms();   /* no stats while she waits */
        } else if (model_ && visible_ && now_fms() >= next_) {
            draw_frame();
            /* the period in fractions of a ms: whole ms (33 for 30 fps) ran her at 30.3 fps, a frame every 3.3 s
             * more than cluster-render's 30 a second shows */
            const double period = 1000.0 / (req_.fps ? req_.fps : 15);
            next_ += period;
            if (next_ < now_fms()) next_ = now_fms() + period;
        }
        stats(now_ms());
        if (client_ >= 0 || model_) idle_since = now_ms();
        else if (activated && opt_.idle_exit_s > 0 && now_ms() - idle_since > opt_.idle_exit_s * 1000LL) break;
    }
    drop_client();
    return 0;
}

int listen_on(const std::string &path)
{
    std::string dir = path.substr(0, path.find_last_of('/'));
    mkdir(dir.c_str(), 0755);
    unlink(path.c_str());
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    sockaddr_un a;
    memset(&a, 0, sizeof a);
    a.sun_family = AF_UNIX;
    strncpy(a.sun_path, path.c_str(), sizeof a.sun_path - 1);
    if (fd < 0 || bind(fd, (sockaddr *)&a, sizeof a) != 0 || listen(fd, 4) != 0) {
        perror(path.c_str());
        return -1;
    }
    return fd;
}

}  // namespace

int main(int argc, char **argv)
{
    Options o;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto val = [&](std::string *out) {
            if (i + 1 >= argc) { fprintf(stderr, "%s needs a value\n", a.c_str()); exit(1); }
            *out = argv[++i];
        };
        if (a == "--socket") val(&o.socket);
        else if (a == "--sdk") val(&o.sdk);
        else if (a == "--state") val(&o.state);
        else if (a == "--cluster-socket") val(&o.cluster_socket);
        else if (a == "--software") o.software = true;
        else if (a == "--stdout") o.to_stdout = true;
        else if (a == "--check") o.check = true;
        else if (a == "--idle-exit") { std::string s; val(&s); o.idle_exit_s = atoi(s.c_str()); }
        else if (a == "--display-wait") { std::string s; val(&s); o.display_wait_s = atoi(s.c_str()); }
        else {
            fprintf(stderr, "usage: live2d-render [--socket PATH] [--sdk DIR] [--state DIR] [--cluster-socket PATH] "
                            "[--software] [--stdout] [--idle-exit S] [--display-wait S]\n");
            return 1;
        }
    }
    /* the lowest CPU priority, nice 19: BMW's own HMI always comes first. 0.1.6 to 0.1.9 ran at nice 10 (a burst
       such as the Store starting stalled her frames at 19); with it, on a busy start (load 6, Nov 23 2026) the
       display service went down about 20 s after she began drawing and stayed down (BMW's map gone from the
       cluster) until the car restarted, and at 19 it came back. Stalled frames are the safer cost */
    setpriority(PRIO_PROCESS, 0, 19);
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = [](int) { g_stop = 1; };
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);
    signal(SIGPIPE, SIG_IGN);
    /* systemd's socket (live2d-render.socket) when started by it, else our own */
    const char *pid = getenv("LISTEN_PID"), *fds = getenv("LISTEN_FDS");
    const bool activated = pid && fds && atoi(pid) == (int)getpid() && atoi(fds) >= 1;
    int listen_fd = activated ? 3 : listen_on(o.socket);
    if (listen_fd < 0) return 2;
    fprintf(stderr, "live2d-render %s: listening%s\n", LIVE2D_RENDER_VERSION, activated ? " (systemd's socket)" : "");
    Service s(o);
    return s.run(listen_fd, activated);
}
