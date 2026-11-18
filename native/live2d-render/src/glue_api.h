/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 James Zhao */
/* The interface between live2d-render and its Cubism glue library (glue/), which
 * is not in this repository or what the Store installs: it holds Live2D's Cubism SDK for
 * Native (its Framework and its closed Core), built on your own computer and
 * copied to the head unit by hand (README.md "The Cubism SDK"). live2d-render
 * loads it with dlopen() and finds these functions by name.
 *
 * Every call but l2d_api() and l2d_error() needs live2d-render's OpenGL ES
 * context current on the calling thread. One model at a time. */
#ifndef LIVE2D_RENDER_GLUE_API_H
#define LIVE2D_RENDER_GLUE_API_H

#ifdef __cplusplus
extern "C" {
#endif

/* Bumped whenever a function below changes; live2d-render refuses a glue
 * library of another version. */
#define L2D_API 1

typedef struct l2d_model l2d_model;

/* L2D_API, as the library was built. */
int l2d_api(void);
/* Why the last call failed ("" if it did not). */
const char *l2d_error(void);

/* Loads <model>.model3.json (its moc, textures and physics, from beside it)
 * for drawing w x h, with mask_textures clipping-mask textures (one holds 36
 * masks). NULL on failure (l2d_error). */
l2d_model *l2d_open(const char *model3_json, unsigned w, unsigned h, unsigned mask_textures);
void l2d_close(l2d_model *m);

int l2d_param_count(const l2d_model *m);
const char *l2d_param_id(const l2d_model *m, int i);
float l2d_param_default(const l2d_model *m, int i);
int l2d_part_index(const l2d_model *m, const char *id);   /* -1: none */

/* One frame: the parameters' values (l2d_param_count of them), then physics
 * over dt seconds, the parts' opacities (count pairs of index and opacity),
 * then the model's own update. physics_ms and core_ms (may be NULL) get the
 * two costs. */
void l2d_update(l2d_model *m, const float *values, const int *part_index, const float *part_opacity, int parts,
                float dt, double *physics_ms, double *core_ms);

/* Optional (a glue without it draws every frame from Core): for running Core
 * on fewer frames than are drawn. keep: the model was just updated; its
 * vertices become the newest pose, the last newest the one before. Then the
 * vertices the next l2d_draw uses become t of the way from the pose before
 * to the newest (t 1: the newest exactly, as it is with no pose before).
 * The model's other state (opacities, draw order) is the newest's. */
void l2d_blend(l2d_model *m, int keep, float t);

/* Draws into the bound framebuffer (cleared by the caller), the model's
 * coordinates through mvp (column-major 4x4). */
void l2d_draw(l2d_model *m, const float mvp[16]);

/* Optional (an older glue lacks it): her GPU memory in bytes, out[0] the model's textures, out[1] the mask
 * buffers, out[2] the vertex and index buffers. */
void l2d_gpu_bytes(const l2d_model *m, long long out[3]);

#ifdef __cplusplus
}
#endif

#endif
