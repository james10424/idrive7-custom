/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 James Zhao */
#include "control.h"

#include <cmath>
#include <cstdlib>

namespace l2r {

namespace {

bool num(const cr::Json &m, const char *key, double *out)
{
    auto it = m.find(key);
    if (it == m.end()) return false;
    char *end = nullptr;
    double v = strtod(it->second.c_str(), &end);
    if (!end || *end || !std::isfinite(v)) return false;
    *out = v;
    return true;
}

}  // namespace

std::vector<std::string> split_list(const std::string &s)
{
    std::vector<std::string> out;
    std::string cur;
    for (char c : s) {
        if (c == ',' || c == ' ' || c == '\t' || c == '\n') {
            if (!cur.empty()) out.push_back(cur);
            cur.clear();
        } else {
            cur.push_back(c);
        }
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}

bool parse_open(const cr::Json &m, OpenRequest *o, std::string *err)
{
    auto str = [&](const char *k, std::string *v) {
        auto it = m.find(k);
        if (it != m.end()) *v = it->second;
    };
    str("model", &o->model);
    if (o->model.empty() || o->model[0] != '/') { *err = "model: an absolute path to a .model3.json"; return false; }
    double v;
    if (!num(m, "w", &v) || v < 4 || v > 1920 || std::fmod(v, 4) != 0) { *err = "w: a multiple of 4, up to 1920"; return false; }
    o->w = (unsigned)v;
    if (!num(m, "h", &v) || v < 2 || v > 720 || std::fmod(v, 2) != 0) { *err = "h: even, up to 720"; return false; }
    o->h = (unsigned)v;
    if (num(m, "fps", &v)) {
        if (v < 1 || v > 30) { *err = "fps: 1 to 30"; return false; }
        o->fps = (unsigned)v;
    }
    if (num(m, "masks", &v)) {
        if (v < 1 || v > 4) { *err = "masks: 1 to 4"; return false; }
        o->masks = (unsigned)v;
    }
    str("target", &o->target);
    str("class", &o->klass);
    if (num(m, "x", &v)) o->x = (int)v;
    if (num(m, "y", &v)) o->y = (int)v;
    if (num(m, "z", &v)) o->z = (int)v;
    if (num(m, "visible", &v)) o->visible = v != 0;
    auto fr = m.find("frame");
    if (fr == m.end()) { *err = "frame: \"cx cy height\" in model units"; return false; }
    std::vector<std::string> f = split_list(fr->second);
    if (f.size() != 3) { *err = "frame: \"cx cy height\" in model units"; return false; }
    o->cx = strtof(f[0].c_str(), nullptr);
    o->cy = strtof(f[1].c_str(), nullptr);
    o->height = strtof(f[2].c_str(), nullptr);
    if (!(o->height > 0)) { *err = "frame: the height above 0"; return false; }
    auto hd = m.find("hide");
    if (hd != m.end()) o->hide = split_list(hd->second);
    return true;
}

void Params::reset(const std::vector<std::string> &ids, const std::vector<float> &defaults)
{
    index_.clear();
    reported_.clear();
    for (size_t i = 0; i < ids.size(); i++) index_[ids[i]] = (int)i;
    defaults_ = defaults;
    values_ = defaults;
}

int Params::index(const std::string &id) const
{
    auto it = index_.find(id);
    return it == index_.end() ? -1 : it->second;
}

int Params::apply(const std::string &list, std::vector<std::string> *unknown)
{
    int set = 0;
    for (const std::string &kv : split_list(list)) {
        size_t eq = kv.find('=');
        if (eq == std::string::npos || eq == 0 || eq + 1 == kv.size()) return -1;
        const std::string id = kv.substr(0, eq);
        char *end = nullptr;
        float v = strtof(kv.c_str() + eq + 1, &end);
        if (!end || *end || !std::isfinite(v)) return -1;
        int i = index(id);
        if (i < 0) {
            if (!reported_[id] && unknown) unknown->push_back(id);
            reported_[id] = true;
            continue;
        }
        values_[i] = v;
        set++;
    }
    return set;
}

void frame_mvp(float cx, float cy, float height, unsigned w, unsigned h, float out[16])
{
    const float sy = 2.0f / height, sx = sy * (float)h / (float)w;
    const float m[16] = {sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, -cx * sx, -cy * sy, 0, 1};
    for (int i = 0; i < 16; i++) out[i] = m[i];
}

}  // namespace l2r
