/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 James Zhao */
/* live2d-render's Cubism glue (../src/glue_api.h): Live2D's Cubism SDK for
 * Native behind a small C interface. Built by build.sh against your copy of
 * the SDK, with its OpenGL ES renderer patched for the head unit
 * (apply_fast.py, csm_fast.hpp); never part of a release (README.md "The Cubism
 * SDK"). The Framework's shaders sit next to the library, in FrameworkShaders/. */
#include <dlfcn.h>
#include <time.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <cmath>
#include <set>
#include <string>
#include <vector>

#include <GLES3/gl3.h>

#include "CubismFramework.hpp"
#include "CubismModelSettingJson.hpp"
#include "ICubismAllocator.hpp"
#include "Id/CubismIdManager.hpp"
#include "Math/CubismMatrix44.hpp"
#include "Model/CubismUserModel.hpp"
#include "Physics/CubismPhysics.hpp"
#include "Utils/CubismJson.hpp"
#include "Rendering/OpenGL/CubismOffscreenManager_OpenGLES2.hpp"
#include "Rendering/OpenGL/CubismRenderer_OpenGLES2.hpp"

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#include "stb_image.h"

#include "../src/glue_api.h"
#include "csm_fast.hpp"

using namespace Live2D::Cubism::Framework;

namespace {

std::string g_error;
std::string g_dir;   /* this library's folder, with a trailing / */
bool g_started = false;

double now_ms()
{
    timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

class Allocator : public ICubismAllocator {
    void *Allocate(csmSizeType size) override { return malloc(size); }
    void Deallocate(void *p) override { free(p); }
    void *AllocateAligned(csmSizeType size, csmUint32 align) override
    {
        void *p = nullptr;
        return posix_memalign(&p, align < sizeof(void *) ? sizeof(void *) : align, size) == 0 ? p : nullptr;
    }
    void DeallocateAligned(void *p) override { free(p); }
};
Allocator g_allocator;

bool read_file(const std::string &path, std::vector<csmByte> *out)
{
    FILE *f = fopen(path.c_str(), "rb");
    if (!f) return false;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    out->resize(n > 0 ? n : 0);
    bool ok = n >= 0 && fread(out->data(), 1, out->size(), f) == out->size();
    fclose(f);
    return ok;
}

/* The Framework reads its shaders through this (FrameworkShaders/..., relative):
 * from this library's folder. Without them it has no shader programs, and the
 * unit's GPU driver crashed drawing. */
csmByte *load_file(const std::string path, csmSizeInt *size)
{
    std::vector<csmByte> b;
    std::string full = path.size() && path[0] == '/' ? path : g_dir + path;
    if (!read_file(full, &b)) {
        fprintf(stderr, "glue: cannot read %s\n", full.c_str());
        *size = 0;
        return nullptr;
    }
    csmByte *p = (csmByte *)malloc(b.size() + 1);
    memcpy(p, b.data(), b.size());
    p[b.size()] = 0;
    *size = (csmSizeInt)b.size();
    return p;
}
void release_bytes(csmByte *b) { free(b); }

bool start_up()
{
    if (g_started) return true;
    Dl_info info;
    if (dladdr((void *)&start_up, &info) && info.dli_fname) {
        g_dir = info.dli_fname;
        g_dir = g_dir.substr(0, g_dir.find_last_of('/') + 1);
    }
    static const char *need[] = {"VertShaderSrc.vert", "FragShaderSrc.frag", "VertShaderSrcSetupMask.vert",
                                 "FragShaderSrcSetupMask.frag"};
    for (const char *f : need) {
        std::vector<csmByte> b;
        if (!read_file(g_dir + "FrameworkShaders/" + f, &b)) {
            g_error = std::string("missing FrameworkShaders/") + f + " next to the glue library";
            return false;
        }
    }
    static CubismFramework::Option option;
    option.LogFunction = [](const char *m) { fprintf(stderr, "cubism: %s", m); };
    option.LoggingLevel = CubismFramework::Option::LogLevel_Warning;
    option.LoadFileFunction = load_file;
    option.ReleaseBytesFunction = release_bytes;
    CubismFramework::StartUp(&g_allocator, &option);
    CubismFramework::Initialize();
    g_started = true;
    return true;
}

}  // namespace

struct l2d_model : public CubismUserModel {
    CubismPhysics *physics() { return _physics; }
    CubismModelSettingJson *setting = nullptr;
    std::vector<GLuint> textures;
    long long textureBytes = 0;   /* the textures' GPU memory (RGBA, no mipmaps) */
    unsigned maskTextures = 1;
    std::vector<std::string> ids;
    std::vector<CubismIdHandle> handles;
    std::vector<float> defaults;
    std::vector<float> posePrev, poseNew;   /* l2d_blend: every drawable's vertices, the pose before and the newest */
    bool havePrev = false;
    std::vector<char> isMask;   /* drawable i is some drawable's mask: blended always (masks are drawn hidden or not) */
    double blendMs = 0;         /* l2d_blend's time and drawables blended, logged every 150 frames */
    long blended = 0, blendTotal = 0;
    /* The wind, in groups of parameters (l2d_set_wind_params): each group a copy of the model's physics with its
     * own wind, run after the calm one, its results kept only for its own parameters (her left hair and ribbons
     * blown left, her right ones right; her body's pendulums stay calm, which a wind strong enough to show in her
     * hair would tip over). */
    struct WindGroup {
        CubismPhysics *physics = nullptr;
        std::vector<char> mask;
        float x = 0, y = 0;
        float ripple = 0, hz = 0;   /* l2d_set_wind_ripple */
    };
    std::vector<csmByte> physicsJson;
    /* the ripple's chains, from the physics file: each output parameter's pendulum (chain, -1 none) and where on
     * it it hangs (0 the root .. 1 the tip); each chain's own phase, so no two swing in step */
    std::vector<int> chainOf;
    std::vector<float> chainAt, chainPhase;
    double rippleT = 0;
    WindGroup wind[L2D_WIND_GROUPS];
    std::vector<float> calm, windy;
    std::vector<float> windWeight;   /* l2d_set_wind_weight: how much of the wind each parameter takes (1 all) */
    int blendFrames = 0;

    ~l2d_model()
    {
        for (WindGroup &g : wind)
            if (g.physics) CubismPhysics::Delete(g.physics);
        if (!textures.empty()) glDeleteTextures((GLsizei)textures.size(), textures.data());
        delete setting;
    }

    /* Each physics output's chain and place on it (the ripple, l2d_set_wind_ripple): the first setting naming a
     * parameter wins */
    void map_chains()
    {
        CubismModel *model = GetModel();
        const int n = model->GetParameterCount();
        chainOf.assign(n, -1);
        chainAt.assign(n, 0);
        chainPhase.clear();
        Utils::CubismJson *js = Utils::CubismJson::Create(physicsJson.data(), (csmSizeInt)physicsJson.size());
        if (!js) return;
        Utils::Value &sets = js->GetRoot()["PhysicsSettings"];
        unsigned seed = 12345;
        for (int s = 0; s < sets.GetSize(); s++) {
            seed = seed * 1103515245u + 12345u;
            chainPhase.push_back((float)((seed >> 8) % 6283) / 1000.0f);
            const int last = sets[s]["Vertices"].GetSize() - 1;
            Utils::Value &outs = sets[s]["Output"];
            for (int o = 0; o < outs.GetSize() && last > 0; o++) {
                const std::string id = outs[o]["Destination"]["Id"].GetRawString();
                for (int i = 0; i < n; i++)
                    if (ids[i] == id) {
                        if (chainOf[i] < 0) {
                            chainOf[i] = s;
                            chainAt[i] = (float)outs[o]["VertexIndex"].ToInt() / (float)last;
                        }
                        break;
                    }
            }
        }
        Utils::CubismJson::Delete(js);
    }

    /* Her textures, packed into atlas pages (CUBISM_NO_ATLAS=1: one texture each, as before). A page holds as
     * many as fit in about 4096 px a side, most used (by drawables) first, so each texture switch between
     * drawables on the same page no longer ends a draw call's run (about 32 of 121 a frame for RetrynowMiku's 17
     * at 1024 px). Each tile has a 2 px border of its edge texels repeated, so bilinear filtering at its edge
     * never reaches its neighbour. The UVs are remapped once, in Core's own arrays (static after the moc loads),
     * so every path that draws or masks reads them. */
    bool load_textures(const std::string &dir)
    {
        const int n = setting->GetTextureCount();
        static const bool noAtlas = getenv("CUBISM_NO_ATLAS") != nullptr;
        const int PAD = noAtlas ? 0 : 2;
        GLint maxTex = 4096;
        glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTex);
        const int limit = std::min<int>(maxTex, 4096 + 8 * PAD);   /* four 1024 px tiles with their borders */
        struct Tile { int w = 0, h = 0, uses = 0, page = -1, x = 0, y = 0; };
        std::vector<Tile> tiles(n);
        CubismModel *model = _model;
        for (int d = 0; d < model->GetDrawableCount(); d++) {
            const int t = model->GetDrawableTextureIndex(d);
            if (t >= 0 && t < n) tiles[t].uses++;
        }
        for (int i = 0; i < n; i++) {
            const std::string tp = dir + setting->GetTextureFileName(i);
            int ch;
            if (!stbi_info(tp.c_str(), &tiles[i].w, &tiles[i].h, &ch)) { g_error = "cannot read " + tp; return false; }
        }
        /* shelves, most used first: rows left to right, a new row when one is full, a new page when it is */
        std::vector<int> order(n);
        for (int i = 0; i < n; i++) order[i] = i;
        std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return tiles[a].uses > tiles[b].uses; });
        struct Page { int w = 0, h = 0; };
        std::vector<Page> pages;
        int x = 0, y = 0, rowH = 0;
        for (int i : order) {
            Tile &t = tiles[i];
            const int sw = t.w + 2 * PAD, sh = t.h + 2 * PAD;
            const bool alone = noAtlas || sw > limit || sh > limit;
            if (!alone && !pages.empty() && x + sw > limit) { x = 0; y += rowH; rowH = 0; }
            if (alone || pages.empty() || y + sh > limit) {
                pages.push_back(Page());
                x = y = rowH = 0;
            }
            t.page = (int)pages.size() - 1;
            t.x = x + PAD;
            t.y = y + PAD;
            Page &pg = pages.back();
            pg.w = std::max(pg.w, x + sw);
            pg.h = std::max(pg.h, y + sh);
            rowH = std::max(rowH, sh);
            x += sw;
            if (alone) y = limit + 1;   /* nothing else goes on its page: the next starts a new one */
        }
        textures.assign(pages.size(), 0);
        glGenTextures((GLsizei)pages.size(), textures.data());
        for (size_t p = 0; p < pages.size(); p++) {
            glBindTexture(GL_TEXTURE_2D, textures[p]);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, pages[p].w, pages[p].h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
            /* No mipmaps: a model's drawings sit tightly packed in its textures, and their smaller levels blend
             * each drawing with its neighbours. With RetrynowMiku's textures shrunk to 1024 px her small mouth
             * then showed the other mouth shapes beside it, like a moustache; plain bilinear draws it clean (and
             * saves a third of the texture memory). Set once: the patched renderer no longer sets them every
             * draw (csm_fast.hpp). */
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, noAtlas ? GL_REPEAT : GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, noAtlas ? GL_REPEAT : GL_CLAMP_TO_EDGE);
            textureBytes += (long long)pages[p].w * pages[p].h * 4;
        }
        std::vector<unsigned char> padded;
        for (int i = 0; i < n; i++) {
            const Tile &t = tiles[i];
            const std::string tp = dir + setting->GetTextureFileName(i);
            int tw, th, ch;
            unsigned char *px = stbi_load(tp.c_str(), &tw, &th, &ch, 4);
            if (!px || tw != t.w || th != t.h) { if (px) stbi_image_free(px); g_error = "cannot decode " + tp; return false; }
            const int pw = tw + 2 * PAD, ph = th + 2 * PAD;
            padded.resize((size_t)pw * ph * 4);
            for (int yy = 0; yy < ph; yy++) {
                const int sy = std::min(std::max(yy - PAD, 0), th - 1);
                unsigned char *row = &padded[(size_t)yy * pw * 4];
                const unsigned char *src = px + (size_t)sy * tw * 4;
                for (int xx = 0; xx < PAD; xx++) memcpy(row + xx * 4, src, 4);
                memcpy(row + PAD * 4, src, (size_t)tw * 4);
                for (int xx = PAD + tw; xx < pw; xx++) memcpy(row + xx * 4, src + (size_t)(tw - 1) * 4, 4);
            }
            stbi_image_free(px);
            glBindTexture(GL_TEXTURE_2D, textures[t.page]);
            glTexSubImage2D(GL_TEXTURE_2D, 0, t.x - PAD, t.y - PAD, pw, ph, GL_RGBA, GL_UNSIGNED_BYTE, padded.data());
            GetRenderer<Rendering::CubismRenderer_OpenGLES2>()->BindTexture(i, textures[t.page]);
        }
        if (!noAtlas) {
            /* the shaders sample (u, 1 - v) with the image's first row at 0: u' = (x + u w) / W and
             * 1 - v' = (y + (1 - v) h) / H, so v' = 1 - (y + (1 - v) h) / H */
            std::set<const void *> done;
            for (int d = 0; d < model->GetDrawableCount(); d++) {
                const int ti = model->GetDrawableTextureIndex(d);
                const Live2D::Cubism::Core::csmVector2 *uv = model->GetDrawableVertexUvs(d);
                if (ti < 0 || ti >= n || !uv || !done.insert(uv).second) continue;
                const Tile &t = tiles[ti];
                const float W = (float)pages[t.page].w, H = (float)pages[t.page].h;
                auto *v = const_cast<Live2D::Cubism::Core::csmVector2 *>(uv);
                for (int k = 0; k < model->GetDrawableVertexCount(d); k++) {
                    v[k].X = (t.x + v[k].X * t.w) / W;
                    v[k].Y = 1.0f - (t.y + (1.0f - v[k].Y) * t.h) / H;
                }
            }
        }
        std::string sizes;
        for (const Page &pg : pages) sizes += (sizes.empty() ? "" : ", ") + std::to_string(pg.w) + "x" + std::to_string(pg.h);
        fprintf(stderr, "glue: %d textures in %d page%s (%s), %.1f MiB\n", n, (int)pages.size(),
                pages.size() == 1 ? "" : "s", sizes.c_str(), textureBytes / (1024.0 * 1024.0));
        return true;
    }

    bool load(const std::string &json, unsigned w, unsigned h, unsigned masks)
    {
        const std::string dir = json.substr(0, json.find_last_of('/') + 1);
        std::vector<csmByte> js, moc;
        if (!read_file(json, &js)) { g_error = "cannot read " + json; return false; }
        setting = new CubismModelSettingJson(js.data(), (csmSizeInt)js.size());
        if (!read_file(dir + setting->GetModelFileName(), &moc)) {
            g_error = std::string("cannot read the moc ") + setting->GetModelFileName();
            return false;
        }
        LoadModel(moc.data(), (csmSizeInt)moc.size());
        if (!_model) { g_error = "the moc did not load (a Core too old for it?)"; return false; }
        if (strcmp(setting->GetPhysicsFileName(), "") != 0) {
            std::vector<csmByte> ph;
            if (read_file(dir + setting->GetPhysicsFileName(), &ph)) {
                LoadPhysics(ph.data(), (csmSizeInt)ph.size());
                physicsJson = ph;   /* kept for the wind's copies (l2d_set_wind_params) */
            }
        }
        maskTextures = masks ? masks : 1;
        CreateRenderer(w, h, maskTextures);
        if (const char *ms = getenv("CUBISM_MASK_SIZE"))   /* debugging: the mask textures' size (Cubism's 256) */
            GetRenderer<Rendering::CubismRenderer_OpenGLES2>()->SetDrawableClippingMaskBufferSize((float)atof(ms), (float)atof(ms));
        if (!load_textures(dir)) return false;
        GetRenderer<Rendering::CubismRenderer_OpenGLES2>()->IsPremultipliedAlpha(false);
        if (glGetError() != GL_NO_ERROR) { g_error = "OpenGL error loading the textures"; return false; }
        isMask.assign(_model->GetDrawableCount(), 0);
        for (int i = 0; i < _model->GetDrawableCount(); i++)
            for (int k = 0; k < _model->GetDrawableMaskCounts()[i]; k++) {
                const int j = _model->GetDrawableMasks()[i][k];
                if (j >= 0 && j < (int)isMask.size()) isMask[j] = 1;
            }
        const int n = _model->GetParameterCount();
        for (int i = 0; i < n; i++) {
            CubismIdHandle id = _model->GetParameterId(i);
            ids.push_back(id->GetString().GetRawString());
            handles.push_back(id);
            defaults.push_back(_model->GetParameterDefaultValue(i));
        }
        if (!physicsJson.empty()) map_chains();   /* after the ids, which it matches */
        return true;
    }
};

extern "C" {

int l2d_api(void) { return L2D_API; }
const char *l2d_error(void) { return g_error.c_str(); }

l2d_model *l2d_open(const char *model3_json, unsigned w, unsigned h, unsigned mask_textures)
{
    g_error.clear();
    if (!start_up()) return nullptr;
    l2d_model *m = new l2d_model();
    if (!m->load(model3_json, w, h, mask_textures)) {
        delete m;
        return nullptr;
    }
    return m;
}

void l2d_close(l2d_model *m) { delete m; }

/* Group g's wind (0 .. L2D_WIND_GROUPS - 1; Cubism's own physics option, a force added to every pendulum's gravity:
 * x to the right, y up, in the same units as gravity's 1 down), kept until set again. A group without parameters
 * (l2d_set_wind_params) has no physics to blow. Optional for live2d-render. */
void l2d_set_wind(l2d_model *m, int g, float x, float y)
{
    if (g < 0 || g >= L2D_WIND_GROUPS) return;
    l2d_model::WindGroup &w = m->wind[g];
    w.x = x;
    w.y = y;
    if (!w.physics) return;
    CubismPhysics::Options o = w.physics->GetOptions();
    o.Wind.X = x;
    o.Wind.Y = y;
    w.physics->SetOptions(o);
}

/* Group g's ripple: a wave running from each of its chains' roots to their tips on top of the wind (the wind alone
 * bends a whole chain one way, so a tail swings as one piece), `amount` of each parameter's half range at the tip
 * (half that at the root), `hz` its frequency; each chain in its own phase. 0 stops it. Optional for live2d-render. */
void l2d_set_wind_ripple(l2d_model *m, int g, float amount, float hz)
{
    if (g < 0 || g >= L2D_WIND_GROUPS) return;
    m->wind[g].ripple = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    m->wind[g].hz = hz < 0 ? 0 : hz > 8 ? 8 : hz;
}

/* How much of the wind (its push and ripple) the comma-separated parameters take: 0 none (the calm physics'), 1 all
 * (every parameter's at first); kept for the model. Returns how many of the ids the model has. Optional for
 * live2d-render. */
int l2d_set_wind_weight(l2d_model *m, const char *csv, float weight)
{
    const int n = m->GetModel()->GetParameterCount();
    if ((int)m->windWeight.size() != n) m->windWeight.assign(n, 1.0f);
    const float k = weight < 0 ? 0 : weight > 1 ? 1 : weight;
    int found = 0;
    const std::string list = csv ? csv : "";
    size_t at = 0;
    while (at <= list.size()) {
        size_t comma = list.find(',', at);
        if (comma == std::string::npos) comma = list.size();
        const std::string id = list.substr(at, comma - at);
        for (int i = 0; i < n && !id.empty(); i++)
            if (m->ids[i] == id) { m->windWeight[i] = k; found++; break; }
        at = comma + 1;
    }
    return found;
}

/* Group g's parameters, comma-separated ids of physics outputs: they take that group's windy physics' values, every
 * other parameter the calm physics'. "" empties the group (no copy run). Returns how many of the ids the model has.
 * Optional for live2d-render. */
int l2d_set_wind_params(l2d_model *m, int g, const char *csv)
{
    if (g < 0 || g >= L2D_WIND_GROUPS) return 0;
    l2d_model::WindGroup &w = m->wind[g];
    const int n = m->GetModel()->GetParameterCount();
    w.mask.assign(n, 0);
    int found = 0;
    const std::string list = csv ? csv : "";
    size_t at = 0;
    while (at <= list.size()) {
        size_t comma = list.find(',', at);
        if (comma == std::string::npos) comma = list.size();
        const std::string id = list.substr(at, comma - at);
        for (int i = 0; i < n && !id.empty(); i++)
            if (m->ids[i] == id) { w.mask[i] = 1; found++; break; }
        at = comma + 1;
    }
    if (w.physics) { CubismPhysics::Delete(w.physics); w.physics = nullptr; }
    if (found && !m->physicsJson.empty()) {
        w.physics = CubismPhysics::Create(m->physicsJson.data(), (csmSizeInt)m->physicsJson.size());
        l2d_set_wind(m, g, w.x, w.y);
    }
    return found;
}

/* Her GPU memory in bytes, as allocated: out[0] the model's textures, out[1] the mask buffers, out[2] the vertex and
 * index buffers (the fast path's: positions and UVs, the indices twice). Optional for live2d-render. */
void l2d_gpu_bytes(const l2d_model *mc, long long out[3])
{
    l2d_model *m = const_cast<l2d_model *>(mc);
    out[0] = m->textureBytes;
    const CubismVector2 ms = m->GetRenderer<Rendering::CubismRenderer_OpenGLES2>()->GetDrawableClippingMaskBufferSize();
    out[1] = (long long)ms.X * (long long)ms.Y * 4 * m->maskTextures;
    CubismModel *model = m->GetModel();
    long long verts = 0, idx = 0;
    for (int i = 0; i < model->GetDrawableCount(); i++) {
        verts += model->GetDrawableVertexCount(i);
        idx += model->GetDrawableVertexIndexCount(i);
    }
    out[2] = verts * 8 * 2 + idx * (verts > 65535 ? 4 : 2) * 2;
}

int l2d_param_count(const l2d_model *m) { return (int)m->ids.size(); }
const char *l2d_param_id(const l2d_model *m, int i) { return i >= 0 && i < (int)m->ids.size() ? m->ids[i].c_str() : ""; }
float l2d_param_default(const l2d_model *m, int i) { return i >= 0 && i < (int)m->defaults.size() ? m->defaults[i] : 0; }

int l2d_part_index(const l2d_model *m, const char *id)
{
    CubismModel *model = const_cast<l2d_model *>(m)->GetModel();
    CubismIdHandle h = CubismFramework::GetIdManager()->GetId(id);
    for (int i = 0; i < model->GetPartCount(); i++)
        if (model->GetPartId(i) == h) return i;
    return -1;
}

void l2d_update(l2d_model *m, const float *values, const int *part_index, const float *part_opacity, int parts,
                float dt, double *physics_ms, double *core_ms)
{
    CubismModel *model = m->GetModel();
    const int n = (int)m->ids.size();
    for (int i = 0; i < n; i++) model->SetParameterValue(i, values[i]);
    double p0 = now_ms();
    static const bool noPhysics = getenv("CUBISM_NO_PHYSICS") != nullptr;   /* debugging: the pose without physics */
    if (m->physics() && dt > 0 && !noPhysics) {
        m->physics()->Evaluate(model, dt);
        /* each wind group's copy after the calm one, every frame (its pendulums keep moving with hers); each
         * keeps only its own parameters' values */
        const int pc = model->GetParameterCount();
        bool any = false;
        for (const l2d_model::WindGroup &w : m->wind) any = any || w.physics;
        if (any) {
            m->calm.resize(pc);
            for (int i = 0; i < pc; i++) m->calm[i] = model->GetParameterValue(i);
            m->windy = m->calm;
            for (l2d_model::WindGroup &w : m->wind) {
                if (!w.physics) continue;
                w.physics->Evaluate(model, dt);
                for (int i = 0; i < pc; i++)
                    if (w.mask[i]) {
                        const float k = i < (int)m->windWeight.size() ? m->windWeight[i] : 1.0f;
                        m->windy[i] = m->calm[i] + k * (model->GetParameterValue(i) - m->calm[i]);
                    }
            }
            /* the ripple: per chain, a wave with a half wavelength along it (RIPPLE_LAG), plus a faster, smaller
             * one, so a tail curls and its tip whips rather than the whole of it leaning */
            static const float RIPPLE_LAG = 3.0f;
            m->rippleT += dt;
            for (l2d_model::WindGroup &w : m->wind) {
                if (!w.physics || w.ripple <= 0 || w.hz <= 0) continue;
                const double ph = 2 * 3.14159265358979 * w.hz * m->rippleT;
                for (int i = 0; i < pc && i < (int)m->chainOf.size(); i++) {
                    const int c = m->chainOf[i];
                    if (!w.mask[i] || c < 0) continue;
                    const float at = m->chainAt[i], p0 = m->chainPhase[c];
                    const float wave = (float)(sin(ph - at * RIPPLE_LAG + p0) +
                                               0.4 * sin(1.87 * ph - at * RIPPLE_LAG * 1.6f + 2 * p0));
                    const float lo = model->GetParameterMinimumValue(i), hi = model->GetParameterMaximumValue(i);
                    const float k = i < (int)m->windWeight.size() ? m->windWeight[i] : 1.0f;
                    float v = m->windy[i] + k * w.ripple * (0.5f + 0.5f * at) * wave / 1.4f * (hi - lo) / 2;
                    m->windy[i] = v < lo ? lo : v > hi ? hi : v;
                }
            }
            for (int i = 0; i < pc; i++) model->SetParameterValue(i, m->windy[i]);
        }
    }
    double p1 = now_ms();
    for (int k = 0; k < parts; k++)
        if (part_index[k] >= 0) model->SetPartOpacity(part_index[k], part_opacity[k]);
    model->Update();
    if (physics_ms) *physics_ms = p1 - p0;
    if (core_ms) *core_ms = now_ms() - p1;
}

void l2d_blend(l2d_model *m, int keep, float t)
{
    const double t0 = now_ms();
    CubismModel *model = m->GetModel();
    const int n = model->GetDrawableCount();
    if (keep) {
        size_t total = 0;
        for (int i = 0; i < n; i++) total += (size_t)model->GetDrawableVertexCount(i) * 2;
        m->posePrev.swap(m->poseNew);
        m->havePrev = m->posePrev.size() == total;
        m->poseNew.resize(total);
        size_t at = 0;
        for (int i = 0; i < n; i++) {
            const size_t c = (size_t)model->GetDrawableVertexCount(i) * 2;
            if (c) memcpy(&m->poseNew[at], model->GetDrawableVertices(i), c * sizeof(float));
            at += c;
        }
    }
    if (m->poseNew.empty()) return;
    /* the vertices Core wrote, overwritten until its next update (it writes them all again; nothing reads them back):
     * everything after reads them there, the masks' bounds as the drawing.
     * Only the drawables drawn are blended: not those hidden (Core's visibility flag, its newest pose) nor those wholly
     * outside the picture last frame (the fast path's bounds), unless they are a mask. A drawable left out keeps
     * Core's newest vertices, so the bounds still see it come into the picture, drawn there the frame after at
     * most. CUBISM_BLEND_ALL=1 blends them all. */
    static const bool all = getenv("CUBISM_BLEND_ALL") != nullptr;
    const std::vector<unsigned char> &out = csmfast::g.out;
    const bool useOut = csmfast::g.skipOut && (int)out.size() == n && (int)m->isMask.size() == n;
    const bool exact = t >= 1.0f || !m->havePrev;
    size_t at = 0;
    for (int i = 0; i < n; i++) {
        const size_t c = (size_t)model->GetDrawableVertexCount(i) * 2;
        m->blendTotal++;
        if (!all && !m->isMask.empty() && !m->isMask[i] &&
            (!model->GetDrawableDynamicFlagIsVisible(i) || (useOut && out[i]))) {
            /* one that left the picture mid-blend may hold blended vertices: the newest again on the exact frame (hidden
             * ones can't: visibility only changes when Core runs, and Core wrote them all) */
            if (!keep && c && exact && model->GetDrawableDynamicFlagIsVisible(i)) memcpy(const_cast<float *>(reinterpret_cast<const float *>(model->GetDrawableVertices(i))), &m->poseNew[at], c * sizeof(float));
            at += c;
            continue;
        }
        m->blended++;
        float *v = const_cast<float *>(reinterpret_cast<const float *>(model->GetDrawableVertices(i)));
        if (exact) {
            if (!keep && c) memcpy(v, &m->poseNew[at], c * sizeof(float));   /* after keep, Core's are the newest */
        } else {
            const float *a = &m->posePrev[at], *b = &m->poseNew[at];
            for (size_t k = 0; k < c; k++) v[k] = a[k] + (b[k] - a[k]) * t;
        }
        at += c;
    }
    m->blendMs += now_ms() - t0;
    if (++m->blendFrames >= 150) {
        fprintf(stderr, "glue: blend %.3f ms a frame, %ld of %ld drawables blended\n", m->blendMs / m->blendFrames,
                m->blended / m->blendFrames, m->blendTotal / m->blendFrames);
        m->blendMs = 0;
        m->blended = m->blendTotal = 0;
        m->blendFrames = 0;
    }
}

void l2d_draw(l2d_model *m, const float mvp[16])
{
    CubismMatrix44 matrix;
    matrix.SetMatrix(const_cast<float *>(mvp));
    auto *r = m->GetRenderer<Rendering::CubismRenderer_OpenGLES2>();
    r->SetMvpMatrix(&matrix);
    Rendering::CubismOffscreenManager_OpenGLES2::GetInstance()->BeginFrameProcess();
    static const bool check = getenv("CUBISM_BATCH_CHECK") != nullptr;   /* debugging: batched and culled against all, one at a time */
    if (check) {
        GLint vp[4];
        glGetIntegerv(GL_VIEWPORT, vp);
        std::vector<unsigned char> one((size_t)vp[2] * vp[3] * 4), all(one.size());
        const bool b = csmfast::g.batch, c = csmfast::g.skipOut;
        csmfast::g.batch = csmfast::g.skipOut = false;   /* the reference: every drawable, one at a time */
        r->DrawModel();
        glReadPixels(vp[0], vp[1], vp[2], vp[3], GL_RGBA, GL_UNSIGNED_BYTE, one.data());
        csmfast::g.batch = b;
        csmfast::g.skipOut = c;
        glClearColor(0, 0, 0, 0);
        glClear(GL_COLOR_BUFFER_BIT);
        r->DrawModel();
        glReadPixels(vp[0], vp[1], vp[2], vp[3], GL_RGBA, GL_UNSIGNED_BYTE, all.data());
        size_t off = 0;
        for (size_t i = 0; i < one.size(); i++) off += one[i] != all[i];
        fprintf(stderr, "batch check: %zu of %zu bytes differ\n", off, one.size());
    } else {
        r->DrawModel();
    }
    Rendering::CubismOffscreenManager_OpenGLES2::GetInstance()->EndFrameProcess();
    Rendering::CubismOffscreenManager_OpenGLES2::GetInstance()->ReleaseStaleRenderTextures();
}

}  // extern "C"
