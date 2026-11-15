/*
 * chibi_live's fast path for Cubism's OpenGL ES renderer (patched/ copies of CubismRenderer_OpenGLES2.cpp and
 * CubismShader_OpenGLES2.cpp include this). Stock Cubism hands the driver every drawable's vertices and indices from
 * CPU memory, re-sets texture parameters, switches the program off and on and re-sends every uniform, ~600 times a
 * frame; on the head unit's Atom the driver's CPU work for that is most of the draw. Here:
 *   - one vertex upload a frame (all drawables' positions in one buffer); UVs and indices in fixed buffers, the
 *     indices already offset to each drawable's vertices, set up once in our own vertex array object;
 *   - GL state (program, textures, uniforms, blending, culling) only sent when it changes.
 * Same GL drawing otherwise, so the same pixels. Only for models without Cubism 5.3 blend modes or offscreens and
 * without high-precision masks; otherwise (or with CUBISM_STOCK=1) the stock path runs.
 */
#pragma once
#include <GLES3/gl3.h>
#include <cstring>
#include <cstdint>
#include <unordered_map>
#include <vector>

namespace csmfast {

struct State {
    bool on = false;          /* this frame draws through the fast path */
    bool built = false, failed = false;
    GLuint vao = 0, vboPos = 0, vboUv = 0, ibo = 0;
    GLenum indexType = GL_UNSIGNED_SHORT;
    std::vector<int> vtxBase, vtxCount, idxCount;
    std::vector<size_t> idxOff;
    std::vector<float> staging;
    int totalVerts = 0;
    int attrib[16] = {0};     /* what our VAO's attribute location feeds: 0 nothing, 1 positions, 2 UVs */
    /* the state last sent this frame */
    GLuint program = 0xffffffffu;
    GLenum active = 0;
    GLuint tex[8];
    GLenum blend[4];
    int cull = -1;
    std::unordered_map<uint64_t, std::vector<float>> uniforms;   /* (program, location) -> last values sent */
    void newFrame() {
        program = 0xffffffffu; active = 0; cull = -1;
        for (GLuint &t : tex) t = 0xffffffffu;
        for (GLenum &b : blend) b = 0xffffffffu;
    }
};
extern State g;

inline void UseProgram(GLuint p) {
    if (!g.on) { glUseProgram(p); return; }
    if (g.program != p) { glUseProgram(p); g.program = p; }
}
inline void ActiveTexture(GLenum unit) {
    if (!g.on) { glActiveTexture(unit); return; }
    if (g.active != unit) { glActiveTexture(unit); g.active = unit; }
}
inline void BindTexture(GLenum target, GLuint t) {
    if (!g.on || target != GL_TEXTURE_2D || g.active < GL_TEXTURE0 || g.active >= GL_TEXTURE0 + 8) { glBindTexture(target, t); return; }
    GLuint &cur = g.tex[g.active - GL_TEXTURE0];
    if (cur != t) { glBindTexture(target, t); cur = t; }
}
inline bool changed(GLint loc, const float *v, int n) {
    if (loc < 0) return false;
    std::vector<float> &c = g.uniforms[((uint64_t)g.program << 32) | (uint32_t)loc];
    if ((int)c.size() == n && memcmp(c.data(), v, n * sizeof(float)) == 0) return false;
    c.assign(v, v + n);
    return true;
}
inline void Uniform1i(GLint loc, GLint v) {
    if (!g.on) { glUniform1i(loc, v); return; }
    float f = (float)v;
    if (changed(loc, &f, 1)) glUniform1i(loc, v);
}
inline void Uniform4f(GLint loc, GLfloat a, GLfloat b, GLfloat c, GLfloat d) {
    if (!g.on) { glUniform4f(loc, a, b, c, d); return; }
    float v[4] = {a, b, c, d};
    if (changed(loc, v, 4)) glUniform4f(loc, a, b, c, d);
}
inline void UniformMatrix4fv(GLint loc, GLsizei n, GLboolean tr, const GLfloat *m) {
    if (!g.on || n != 1 || tr) { glUniformMatrix4fv(loc, n, tr, m); return; }
    if (changed(loc, m, 16)) glUniformMatrix4fv(loc, 1, GL_FALSE, m);
}
inline void BlendFuncSeparate(GLenum a, GLenum b, GLenum c, GLenum d) {
    if (!g.on) { glBlendFuncSeparate(a, b, c, d); return; }
    if (g.blend[0] != a || g.blend[1] != b || g.blend[2] != c || g.blend[3] != d) {
        glBlendFuncSeparate(a, b, c, d);
        g.blend[0] = a; g.blend[1] = b; g.blend[2] = c; g.blend[3] = d;
    }
}
inline void Cull(bool on) {
    if (g.cull == (int)on) return;
    if (on) glEnable(GL_CULL_FACE); else glDisable(GL_CULL_FACE);
    g.cull = on;
}
/* our VAO's attribute location loc reads positions (what 1) or UVs (2) */
inline void Attrib(GLuint loc, int what) {
    if (loc >= 16 || g.attrib[loc] == what) return;
    glBindBuffer(GL_ARRAY_BUFFER, what == 1 ? g.vboPos : g.vboUv);
    glEnableVertexAttribArray(loc);
    glVertexAttribPointer(loc, 2, GL_FLOAT, GL_FALSE, 0, nullptr);
    g.attrib[loc] = what;
}

}  // namespace csmfast
