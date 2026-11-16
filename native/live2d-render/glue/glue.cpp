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
    std::vector<std::string> ids;
    std::vector<CubismIdHandle> handles;
    std::vector<float> defaults;

    ~l2d_model()
    {
        if (!textures.empty()) glDeleteTextures((GLsizei)textures.size(), textures.data());
        delete setting;
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
            if (read_file(dir + setting->GetPhysicsFileName(), &ph)) LoadPhysics(ph.data(), (csmSizeInt)ph.size());
        }
        CreateRenderer(w, h, masks ? masks : 1);
        if (const char *ms = getenv("CUBISM_MASK_SIZE"))   /* debugging: the mask textures' size (Cubism's 256) */
            GetRenderer<Rendering::CubismRenderer_OpenGLES2>()->SetDrawableClippingMaskBufferSize((float)atof(ms), (float)atof(ms));
        for (int i = 0; i < setting->GetTextureCount(); i++) {
            const std::string tp = dir + setting->GetTextureFileName(i);
            int tw, th, ch;
            unsigned char *px = stbi_load(tp.c_str(), &tw, &th, &ch, 4);
            if (!px) { g_error = "cannot decode " + tp; return false; }
            GLuint tex;
            glGenTextures(1, &tex);
            glBindTexture(GL_TEXTURE_2D, tex);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, tw, th, 0, GL_RGBA, GL_UNSIGNED_BYTE, px);
            stbi_image_free(px);
            /* No mipmaps: a model's drawings sit tightly packed in its textures, and their smaller levels blend
             * each drawing with its neighbours. With RetrynowMiku's textures shrunk to 1024 px her small mouth
             * then showed the other mouth shapes beside it, like a moustache; plain bilinear draws it clean (and
             * saves a third of the texture memory). Set once: the patched renderer no longer sets them every
             * draw (csm_fast.hpp). */
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
            textures.push_back(tex);
            GetRenderer<Rendering::CubismRenderer_OpenGLES2>()->BindTexture(i, tex);
        }
        GetRenderer<Rendering::CubismRenderer_OpenGLES2>()->IsPremultipliedAlpha(false);
        if (glGetError() != GL_NO_ERROR) { g_error = "OpenGL error loading the textures"; return false; }
        const int n = _model->GetParameterCount();
        for (int i = 0; i < n; i++) {
            CubismIdHandle id = _model->GetParameterId(i);
            ids.push_back(id->GetString().GetRawString());
            handles.push_back(id);
            defaults.push_back(_model->GetParameterDefaultValue(i));
        }
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
    if (m->physics() && dt > 0 && !noPhysics) m->physics()->Evaluate(model, dt);
    double p1 = now_ms();
    for (int k = 0; k < parts; k++)
        if (part_index[k] >= 0) model->SetPartOpacity(part_index[k], part_opacity[k]);
    model->Update();
    if (physics_ms) *physics_ms = p1 - p0;
    if (core_ms) *core_ms = now_ms() - p1;
}

void l2d_draw(l2d_model *m, const float mvp[16])
{
    CubismMatrix44 matrix;
    matrix.SetMatrix(const_cast<float *>(mvp));
    auto *r = m->GetRenderer<Rendering::CubismRenderer_OpenGLES2>();
    r->SetMvpMatrix(&matrix);
    Rendering::CubismOffscreenManager_OpenGLES2::GetInstance()->BeginFrameProcess();
    static const bool check = getenv("CUBISM_BATCH_CHECK") != nullptr;   /* debugging: batched against one at a time */
    if (check) {
        GLint vp[4];
        glGetIntegerv(GL_VIEWPORT, vp);
        std::vector<unsigned char> one((size_t)vp[2] * vp[3] * 4), all(one.size());
        const bool b = csmfast::g.batch;
        csmfast::g.batch = false;
        r->DrawModel();
        glReadPixels(vp[0], vp[1], vp[2], vp[3], GL_RGBA, GL_UNSIGNED_BYTE, one.data());
        csmfast::g.batch = b;
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
