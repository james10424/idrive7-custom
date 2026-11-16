/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 James Zhao */
#include "gpu.h"

#include <EGL/eglext.h>
#include <fcntl.h>
#include <gbm.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>

namespace l2r {

namespace {

/* One full-screen triangle; the fragment shader writes 4 atlas bytes a texel.
 * The Y target is w/4 x h, the UV target w/4 x h/2 (each row: U, then V);
 * output row j is picture row j from the top. Integer maths as the
 * reference's (floor on small exact integers), so the bytes match it. */
const char *kVert =
    "#version 300 es\n"
    "void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n"
    "  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }\n";
const char *kFrag =
    "#version 300 es\n"
    "precision highp float; precision highp int;\n"
    "uniform highp sampler2D u_src; uniform int u_w; uniform int u_h; uniform int u_uv;\n"
    "out vec4 o;\n"
    "vec3 px(int x, int y) {\n"
    "  vec4 c = floor(texelFetch(u_src, ivec2(x, u_h - 1 - y), 0) * 255.0 + 0.5);\n"
    "  return floor(c.rgb * c.a / 255.0 + 0.0001); }\n"
    "float yOf(vec3 c) { return 16.0 + floor((66.0 * c.r + 129.0 * c.g + 25.0 * c.b + 128.0) / 256.0); }\n"
    "float uOf(vec3 c) { return 128.0 + floor((-38.0 * c.r - 74.0 * c.g + 112.0 * c.b + 128.0) / 256.0); }\n"
    "float vOf(vec3 c) { return 128.0 + floor((112.0 * c.r - 94.0 * c.g - 18.0 * c.b + 128.0) / 256.0); }\n"
    "float one(int i, int row) {\n"
    "  if (u_uv == 0) return yOf(px(i, row));\n"
    "  int half_ = u_w / 2;\n"
    "  if (i < half_) return uOf(px(2 * i, 2 * row));\n"
    "  return vOf(px(2 * (i - half_), 2 * row)); }\n"
    "void main() { int i = int(gl_FragCoord.x) * 4, row = int(gl_FragCoord.y);\n"
    "  o = vec4(one(i, row), one(i + 1, row), one(i + 2, row), one(i + 3, row)) / 255.0; }\n";

GLuint compile(GLenum type, const char *src, std::string *err)
{
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, nullptr);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[1024] = "";
        glGetShaderInfoLog(s, sizeof log, nullptr, log);
        *err = std::string("4:2:0 shader: ") + log;
        glDeleteShader(s);
        return 0;
    }
    return s;
}

bool target(GLuint *tex, GLuint *fbo, unsigned w, unsigned h)
{
    glGenTextures(1, tex);
    glBindTexture(GL_TEXTURE_2D, *tex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);   /* no mipmaps: complete for texelFetch */
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glGenFramebuffers(1, fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, *fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, *tex, 0);
    return glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
}

}  // namespace

Gpu::~Gpu()
{
    if (dpy_ != EGL_NO_DISPLAY) {
        free_targets();
        eglMakeCurrent(dpy_, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if (ctx_ != EGL_NO_CONTEXT) eglDestroyContext(dpy_, ctx_);
        eglTerminate(dpy_);
    }
    if (gbm_) gbm_device_destroy((gbm_device *)gbm_);
    if (fd_ >= 0) close(fd_);
}

bool Gpu::init(bool software, std::string *err)
{
    if (software) {
        auto gpd = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
        dpy_ = gpd ? gpd(0x31DD /* EGL_PLATFORM_SURFACELESS_MESA */, EGL_DEFAULT_DISPLAY, nullptr) : EGL_NO_DISPLAY;
    } else {
        fd_ = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
        if (fd_ < 0) { *err = "cannot open /dev/dri/renderD128"; return false; }
        gbm_ = gbm_create_device(fd_);
        if (!gbm_) { *err = "gbm_create_device failed"; return false; }
        dpy_ = eglGetDisplay((EGLNativeDisplayType)gbm_);
    }
    EGLint maj, min;
    if (dpy_ == EGL_NO_DISPLAY || !eglInitialize(dpy_, &maj, &min)) {
        char b[64];
        snprintf(b, sizeof b, "eglInitialize failed (0x%x)", eglGetError());
        *err = b;
        return false;
    }
    eglBindAPI(EGL_OPENGL_ES_API);
    const EGLint any[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE};
    EGLConfig cfg = (EGLConfig)0;
    EGLint n = 0;
    if (!eglChooseConfig(dpy_, any, &cfg, 1, &n) || n < 1) cfg = (EGLConfig)0;   /* EGL_KHR_no_config_context */
    const EGLint attrs[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    ctx_ = eglCreateContext(dpy_, cfg, EGL_NO_CONTEXT, attrs);
    if (ctx_ == EGL_NO_CONTEXT || !eglMakeCurrent(dpy_, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx_)) {
        char b[64];
        snprintf(b, sizeof b, "no OpenGL ES 3 context (0x%x)", eglGetError());
        *err = b;
        return false;
    }
    GLuint vs = compile(GL_VERTEX_SHADER, kVert, err), fs = vs ? compile(GL_FRAGMENT_SHADER, kFrag, err) : 0;
    if (!vs || !fs) return false;
    prog_ = glCreateProgram();
    glAttachShader(prog_, vs);
    glAttachShader(prog_, fs);
    glLinkProgram(prog_);
    glDeleteShader(vs);
    glDeleteShader(fs);
    GLint ok = 0;
    glGetProgramiv(prog_, GL_LINK_STATUS, &ok);
    if (!ok) { *err = "4:2:0 program did not link"; return false; }
    u_src_ = glGetUniformLocation(prog_, "u_src");
    u_w_ = glGetUniformLocation(prog_, "u_w");
    u_h_ = glGetUniformLocation(prog_, "u_h");
    u_uv_ = glGetUniformLocation(prog_, "u_uv");
    glGenVertexArrays(1, &vao_);   /* ours, no arrays enabled: nothing of the model's is fetched */
    return glGetError() == GL_NO_ERROR || (*err = "OpenGL error setting up", false);
}

std::string Gpu::renderer() const
{
    const char *v = (const char *)glGetString(GL_VERSION), *r = (const char *)glGetString(GL_RENDERER);
    return std::string(v ? v : "?") + " on " + (r ? r : "?");
}

void Gpu::free_targets()
{
    atlas_drop();
    if (pbo_) glDeleteBuffers(1, &pbo_);
    pbo_ = 0;
    GLuint t[] = {tex_, ytex_, uvtex_}, f[] = {fbo_, yfbo_, uvfbo_};
    glDeleteTextures(3, t);
    glDeleteFramebuffers(3, f);
    tex_ = ytex_ = uvtex_ = fbo_ = yfbo_ = uvfbo_ = 0;
    w_ = h_ = 0;
}

bool Gpu::size(unsigned w, unsigned h, std::string *err)
{
    if (w == w_ && h == h_ && fbo_) return true;
    if (!w || !h || w % 4 || h % 2 || w > 1920 || h > 720) { *err = "size: w a multiple of 4, h even, up to 1920x720"; return false; }
    free_targets();
    if (!target(&tex_, &fbo_, w, h) || !target(&ytex_, &yfbo_, w / 4, h) || !target(&uvtex_, &uvfbo_, w / 4, h / 2)) {
        *err = "framebuffer incomplete";
        free_targets();
        return false;
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glGenBuffers(1, &pbo_);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, pbo_);
    glBufferData(GL_PIXEL_PACK_BUFFER, (GLsizeiptr)w * h * 3 / 2, nullptr, GL_STREAM_READ);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    w_ = w;
    h_ = h;
    return true;
}

void Gpu::begin()
{
    glBindFramebuffer(GL_FRAMEBUFFER, fbo_);
    glViewport(0, 0, w_, h_);
    glDisable(GL_SCISSOR_TEST);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glClearColor(0, 0, 0, 0);
    glClear(GL_COLOR_BUFFER_BIT);
}

bool Gpu::atlas_start(std::string *err)
{
    atlas_drop();
    /* our own state after the model's drawing */
    glDisable(GL_BLEND);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_STENCIL_TEST);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_CULL_FACE);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glUseProgram(prog_);
    glBindVertexArray(vao_);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, tex_);
    glUniform1i(u_src_, 0);
    glUniform1i(u_w_, (GLint)w_);
    glUniform1i(u_h_, (GLint)h_);
    glBindFramebuffer(GL_FRAMEBUFFER, yfbo_);
    glViewport(0, 0, w_ / 4, h_);
    glUniform1i(u_uv_, 0);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glBindFramebuffer(GL_FRAMEBUFFER, uvfbo_);
    glViewport(0, 0, w_ / 4, h_ / 2);
    glUniform1i(u_uv_, 1);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glBindVertexArray(0);
    /* into the buffer: the reads return at once, the GPU fills it after the drawing */
    glPixelStorei(GL_PACK_ALIGNMENT, 4);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, pbo_);
    glBindFramebuffer(GL_FRAMEBUFFER, yfbo_);
    glReadPixels(0, 0, w_ / 4, h_, GL_RGBA, GL_UNSIGNED_BYTE, (void *)0);
    glBindFramebuffer(GL_FRAMEBUFFER, uvfbo_);
    glReadPixels(0, 0, w_ / 4, h_ / 2, GL_RGBA, GL_UNSIGNED_BYTE, (void *)((size_t)w_ * h_));
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    fence_ = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    glFlush();   /* the GPU starts now, not at the next call */
    GLenum e = glGetError();
    if (e != GL_NO_ERROR || !fence_) {
        char b[48];
        snprintf(b, sizeof b, "OpenGL error 0x%x", e);
        *err = b;
        atlas_drop();
        return false;
    }
    return true;
}

bool Gpu::atlas_done(std::vector<uint8_t> *out, std::string *err)
{
    if (!fence_) { *err = "no frame started"; return false; }
    GLenum r = glClientWaitSync(fence_, GL_SYNC_FLUSH_COMMANDS_BIT, 1000000000ull);
    atlas_drop();
    if (r != GL_ALREADY_SIGNALED && r != GL_CONDITION_SATISFIED) {
        *err = r == GL_TIMEOUT_EXPIRED ? "the GPU took over a second" : "waiting for the GPU failed";
        return false;
    }
    const size_t n = (size_t)w_ * h_ * 3 / 2;
    out->resize(n);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, pbo_);
    const void *p = glMapBufferRange(GL_PIXEL_PACK_BUFFER, 0, (GLsizeiptr)n, GL_MAP_READ_BIT);
    if (p) memcpy(out->data(), p, n);
    if (p) glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    GLenum e = glGetError();
    if (!p || e != GL_NO_ERROR) {
        char b[48];
        snprintf(b, sizeof b, "reading the frame: OpenGL error 0x%x", e);
        *err = b;
        return false;
    }
    return true;
}

void Gpu::atlas_drop()
{
    if (fence_) glDeleteSync(fence_);
    fence_ = nullptr;
}

void Gpu::picture(std::vector<uint8_t> *rgba)
{
    rgba->resize((size_t)w_ * h_ * 4);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo_);
    glReadPixels(0, 0, w_, h_, GL_RGBA, GL_UNSIGNED_BYTE, rgba->data());
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
}

void yuv420_reference(const uint8_t *rgba, unsigned w, unsigned h, uint8_t *atlas)
{
    uint8_t *Y = atlas, *UV = atlas + (size_t)w * h;
    for (unsigned y = 0; y < h; y++) {
        const uint8_t *row = rgba + (size_t)(h - 1 - y) * w * 4;
        for (unsigned x = 0; x < w; x++) {
            int a = row[x * 4 + 3], r = row[x * 4] * a / 255, g = row[x * 4 + 1] * a / 255, b = row[x * 4 + 2] * a / 255;
            Y[(size_t)y * w + x] = (uint8_t)(16 + ((66 * r + 129 * g + 25 * b + 128) >> 8));
            if (!(y & 1) && !(x & 1)) {
                UV[(size_t)(y / 2) * w + x / 2] = (uint8_t)(128 + ((-38 * r - 74 * g + 112 * b + 128) >> 8));
                UV[(size_t)(y / 2) * w + w / 2 + x / 2] = (uint8_t)(128 + ((112 * r - 94 * g - 18 * b + 128) >> 8));
            }
        }
    }
}

}  // namespace l2r
