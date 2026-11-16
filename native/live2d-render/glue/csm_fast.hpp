/*
 * chibi_live's fast path for Cubism's OpenGL ES renderer (patched/ copies of CubismRenderer_OpenGLES2.cpp and
 * CubismShader_OpenGLES2.cpp include this). Stock Cubism hands the driver every drawable's vertices and indices from
 * CPU memory, re-sets texture parameters, switches the program off and on and re-sends every uniform, ~600 times a
 * frame; on the head unit's Atom the driver's CPU work for that is most of the draw. Here:
 *   - one vertex upload a frame (all drawables' positions in one buffer); UVs and indices in fixed buffers, the
 *     indices already offset to each drawable's vertices, set up once in our own vertex array object;
 *   - GL state (program, textures, uniforms, blending, culling) only sent when it changes.
 *   - drawables drawn one after another with the same state go to the GPU as one draw: each draw waits until a
 *     state change ends its run. The index buffer holds every drawable's indices once, then again in the order
 *     they were drawn last frame (masks included), so a run that repeats last frame's order is one range of it;
 *     when the order changes (a drawable shown or hidden) that part is laid out again. GL draws a call's
 *     triangles in order, so the blending is the same. CUBISM_NOBATCH=1 draws one at a time.
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
    std::vector<size_t> idxOff;     /* each drawable's indices in the index buffer's first part */
    std::vector<unsigned char> ibDrawable;   /* that part: the indices in drawable order, offset to their vertices */
    std::vector<int> seq;           /* the drawables drawn so far this frame, in order */
    std::vector<int> laidSeq;       /* the order the second part is laid out in */
    std::vector<size_t> laidOff;    /* each of its draws' indices there */
    long relaid = 0;
    bool batch = true;
    size_t pendOff = 0;             /* the run waiting to be drawn: its indices */
    int pendCount = 0;
    long draws = 0, drawables = 0;  /* counted for the log */
    std::vector<float> staging;
    int totalVerts = 0;
    int attrib[16] = {0};     /* what our VAO's attribute location feeds: 0 nothing, 1 positions, 2 UVs */
    /* the state last sent this frame */
    GLuint program = 0xffffffffu;
    GLenum active = 0, glActive = 0;   /* the texture unit asked for, and the one GL has */
    GLuint tex[8];
    GLenum blend[4];
    int cull = -1;
    std::unordered_map<uint64_t, std::vector<float>> uniforms;   /* (program, location) -> last values sent */
    void newFrame() {
        program = 0xffffffffu; active = glActive = 0; cull = -1;
        for (GLuint &t : tex) t = 0xffffffffu;
        for (GLenum &b : blend) b = 0xffffffffu;
    }
};
extern State g;

inline size_t IndexSize() { return g.indexType == GL_UNSIGNED_INT ? 4 : 2; }
/* draws the waiting run; before any state change goes to GL */
inline void Flush() {
    if (!g.pendCount) return;
    glDrawElements(GL_TRIANGLES, g.pendCount, g.indexType, reinterpret_cast<const void *>(g.pendOff));
    g.pendCount = 0;
    g.draws++;
}
/* drawable i's triangles: added to the waiting run when they follow it in the index buffer, else they start a
 * new one (batch false: drawn now; nothing else waits) */
inline void Draw(int i, bool batch) {
    const int n = g.idxCount[i];
    if (n <= 0 || g.vtxCount[i] <= 0) return;
    g.drawables++;
    const size_t k = g.seq.size();
    g.seq.push_back(i);
    const size_t off = k < g.laidSeq.size() && g.laidSeq[k] == i ? g.laidOff[k] : g.idxOff[i];
    if (batch && g.batch && g.pendCount && off == g.pendOff + (size_t)g.pendCount * IndexSize()) {
        g.pendCount += n;
        return;
    }
    Flush();
    g.pendOff = off;
    g.pendCount = n;
    if (!batch || !g.batch) Flush();
}

inline void UseProgram(GLuint p) {
    if (!g.on) { glUseProgram(p); return; }
    if (g.program != p) { Flush(); glUseProgram(p); g.program = p; }
}
/* the unit is only chosen, not sent: switching units draws nothing, so it goes to GL with the next bind that does
 * change a unit's texture (g.active is the unit asked for, g.glActive the one GL has) */
inline void ActiveTexture(GLenum unit) {
    if (!g.on) { glActiveTexture(unit); g.glActive = unit; return; }
    g.active = unit;
}
inline void sendActive() {
    if (g.glActive != g.active) { glActiveTexture(g.active); g.glActive = g.active; }
}
inline void BindTexture(GLenum target, GLuint t) {
    if (!g.on || target != GL_TEXTURE_2D || g.active < GL_TEXTURE0 || g.active >= GL_TEXTURE0 + 8) {
        Flush(); if (g.on) sendActive(); glBindTexture(target, t); return;
    }
    GLuint &cur = g.tex[g.active - GL_TEXTURE0];
    if (cur != t) { Flush(); sendActive(); glBindTexture(target, t); cur = t; }
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
    if (changed(loc, &f, 1)) { Flush(); glUniform1i(loc, v); }
}
inline void Uniform4f(GLint loc, GLfloat a, GLfloat b, GLfloat c, GLfloat d) {
    if (!g.on) { glUniform4f(loc, a, b, c, d); return; }
    float v[4] = {a, b, c, d};
    if (changed(loc, v, 4)) { Flush(); glUniform4f(loc, a, b, c, d); }
}
inline void UniformMatrix4fv(GLint loc, GLsizei n, GLboolean tr, const GLfloat *m) {
    if (!g.on || n != 1 || tr) { Flush(); glUniformMatrix4fv(loc, n, tr, m); return; }
    if (changed(loc, m, 16)) { Flush(); glUniformMatrix4fv(loc, 1, GL_FALSE, m); }
}
inline void BlendFuncSeparate(GLenum a, GLenum b, GLenum c, GLenum d) {
    if (!g.on) { glBlendFuncSeparate(a, b, c, d); return; }
    if (g.blend[0] != a || g.blend[1] != b || g.blend[2] != c || g.blend[3] != d) {
        Flush();
        glBlendFuncSeparate(a, b, c, d);
        g.blend[0] = a; g.blend[1] = b; g.blend[2] = c; g.blend[3] = d;
    }
}
inline void Cull(bool on) {
    if (g.cull == (int)on) return;
    Flush();
    if (on) glEnable(GL_CULL_FACE); else glDisable(GL_CULL_FACE);
    g.cull = on;
}
/* our VAO's attribute location loc reads positions (what 1) or UVs (2) */
inline void Attrib(GLuint loc, int what) {
    if (loc >= 16 || g.attrib[loc] == what) return;
    Flush();
    glBindBuffer(GL_ARRAY_BUFFER, what == 1 ? g.vboPos : g.vboUv);
    glEnableVertexAttribArray(loc);
    glVertexAttribPointer(loc, 2, GL_FLOAT, GL_FALSE, 0, nullptr);
    g.attrib[loc] = what;
}

/* at the frame's end, our VAO bound and everything drawn: when this frame's order differs from the laid out one,
 * the buffer again (the GPU may still read the old one: a fresh buffer, not overwritten) */
inline void EndFrame() {
    if (g.seq != g.laidSeq) {
        const size_t isz = IndexSize();
        size_t total = g.ibDrawable.size();
        g.laidOff.resize(g.seq.size());
        for (size_t k = 0; k < g.seq.size(); k++) { g.laidOff[k] = total; total += (size_t)g.idxCount[g.seq[k]] * isz; }
        std::vector<unsigned char> ib(total);
        memcpy(ib.data(), g.ibDrawable.data(), g.ibDrawable.size());
        for (size_t k = 0; k < g.seq.size(); k++)
            memcpy(&ib[g.laidOff[k]], &g.ibDrawable[g.idxOff[g.seq[k]]], (size_t)g.idxCount[g.seq[k]] * isz);
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)total, ib.data(), GL_DYNAMIC_DRAW);
        g.laidSeq.swap(g.seq);
        g.relaid++;
    }
    g.seq.clear();
}

}  // namespace csmfast
