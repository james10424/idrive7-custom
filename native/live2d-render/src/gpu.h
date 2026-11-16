/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 James Zhao */
/* live2d-render's OpenGL ES side: a context with no screen on the head unit's
 * GPU (GBM on /dev/dri/renderD128, or Mesa's software renderer for trying it
 * off the car), the w x h picture the model is drawn into, and that picture
 * turned into the 4:2:0 atlas a cluster-render video layer takes, on the GPU:
 * two small passes write the bytes in the atlas's own order, so one read of
 * 1.5 bytes a pixel fills it (no conversion on the CPU). The read goes into a
 * buffer of the GPU's behind a fence, so the CPU doesn't wait for the drawing:
 * a frame is started, and collected while the next is being worked out. */
#ifndef LIVE2D_RENDER_GPU_H
#define LIVE2D_RENDER_GPU_H

#include <stdint.h>
#include <string>
#include <vector>

#include <EGL/egl.h>
#include <GLES3/gl3.h>

namespace l2r {

class Gpu {
public:
    ~Gpu();
    /* software: Mesa's surfaceless platform (llvmpipe) instead of the GPU. */
    bool init(bool software, std::string *err);
    std::string renderer() const;

    /* The picture's size (w a multiple of 4, h even); remade when it changes. */
    bool size(unsigned w, unsigned h, std::string *err);
    unsigned w() const { return w_; }
    unsigned h() const { return h_; }
    /* Binds the picture's framebuffer, cleared to transparent. */
    void begin();
    /* Turns the picture into the 4:2:0 atlas (premultiplied over black: the
     * HUD shows black as nothing) and starts reading it into the GPU's buffer,
     * without waiting: atlas_done collects it. One read at a time. */
    bool atlas_start(std::string *err);
    bool atlas_pending() const { return fence_ != nullptr; }
    /* Waits for the started read (a second at most) and copies it into *atlas
     * (w*h*3/2 bytes). */
    bool atlas_done(std::vector<uint8_t> *atlas, std::string *err);
    /* Forgets a started read. */
    void atlas_drop();
    /* The picture as RGBA, bottom row first (for checking the atlas). */
    void picture(std::vector<uint8_t> *rgba);

private:
    EGLDisplay dpy_ = EGL_NO_DISPLAY;
    EGLContext ctx_ = EGL_NO_CONTEXT;
    int fd_ = -1;
    void *gbm_ = nullptr;
    unsigned w_ = 0, h_ = 0;
    GLuint tex_ = 0, fbo_ = 0;
    GLuint prog_ = 0, vao_ = 0, ytex_ = 0, uvtex_ = 0, yfbo_ = 0, uvfbo_ = 0;
    GLint u_src_ = -1, u_w_ = -1, u_h_ = -1, u_uv_ = -1;
    GLuint pbo_ = 0;
    GLsync fence_ = nullptr;
    void free_targets();
};

/* BT.601 limited range 4:2:0 of a bottom-up RGBA picture as Gpu::atlas makes
 * it (chroma from each 2x2 block's top-left pixel): the reference its tests
 * compare with. */
void yuv420_reference(const uint8_t *rgba, unsigned w, unsigned h, uint8_t *atlas);

}  // namespace l2r

#endif
