#!/usr/bin/env python3
"""Applies live2d-render's fast path (csm_fast.hpp) to copies of the Cubism SDK's OpenGL ES renderer and shader
files, in the current folder (build.sh copies them in from your SDK first): CubismRenderer_OpenGLES2.cpp and
CubismShader_OpenGLES2.cpp. Written for Cubism SDK for Native 5-r.5; it stops if an anchor isn't found."""
import sys

s = ''


def rep(a, b):
    global s
    if s.count(a) != 1:
        sys.exit('anchor found %d times: %r' % (s.count(a), a[:80]))
    s = s.replace(a, b)


s = open('CubismRenderer_OpenGLES2.cpp', encoding='utf-8').read()
if 'csmfast' in s:
    sys.exit('already applied')
rep('#include "Model/CubismModel.hpp"\n', '''#include "Model/CubismModel.hpp"
#include "csm_fast.hpp"
#include <cstdio>
#include <cstdlib>
csmfast::State csmfast::g;

/* the fast path's fixed buffers (UVs, indices offset to each drawable's vertices), once */
static bool csmFastBuild(const Live2D::Cubism::Framework::CubismModel &model) {
    using namespace csmfast;
    const int n = model.GetDrawableCount();
    g.vtxBase.resize(n); g.vtxCount.resize(n); g.idxCount.resize(n); g.idxOff.resize(n);
    int verts = 0, idx = 0;
    for (int i = 0; i < n; i++) {
        g.vtxBase[i] = verts; g.vtxCount[i] = model.GetDrawableVertexCount(i); verts += g.vtxCount[i];
        g.idxCount[i] = model.GetDrawableVertexIndexCount(i); idx += g.idxCount[i];
    }
    g.totalVerts = verts;
    g.indexType = verts > 65535 ? GL_UNSIGNED_INT : GL_UNSIGNED_SHORT;
    const size_t isz = g.indexType == GL_UNSIGNED_INT ? 4 : 2;
    std::vector<float> uv((size_t)verts * 2);
    std::vector<unsigned char> ib((size_t)idx * isz);
    size_t at = 0;
    for (int i = 0; i < n; i++) {
        if (g.vtxCount[i]) memcpy(&uv[(size_t)g.vtxBase[i] * 2], model.GetDrawableVertexUvs(i), (size_t)g.vtxCount[i] * 8);
        g.idxOff[i] = at * isz;
        const uint16_t *src = (const uint16_t *)model.GetDrawableVertexIndices(i);
        for (int k = 0; k < g.idxCount[i]; k++, at++) {
            unsigned v = (unsigned)src[k] + (unsigned)g.vtxBase[i];
            if (isz == 4) ((uint32_t *)ib.data())[at] = v; else ((uint16_t *)ib.data())[at] = (uint16_t)v;
        }
    }
    g.ibDrawable = ib;
    g.seq.clear(); g.laidSeq.clear(); g.laidOff.clear();
    g.batch = getenv("CUBISM_NOBATCH") == NULL;
    g.staging.resize((size_t)verts * 2);
    glGenVertexArrays(1, &g.vao);
    glBindVertexArray(g.vao);
    glGenBuffers(1, &g.vboPos); glGenBuffers(1, &g.vboUv); glGenBuffers(1, &g.ibo);
    glBindBuffer(GL_ARRAY_BUFFER, g.vboPos);
    glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(g.staging.size() * 4), nullptr, GL_STREAM_DRAW);
    glBindBuffer(GL_ARRAY_BUFFER, g.vboUv);
    glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(uv.size() * 4), uv.data(), GL_STATIC_DRAW);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, g.ibo);   /* part of the VAO */
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)ib.size(), ib.data(), GL_DYNAMIC_DRAW);
    glBindVertexArray(0);
    glBindBuffer(GL_ARRAY_BUFFER, 0);
    if (glGetError() != GL_NO_ERROR) { fprintf(stderr, "fast path: buffers failed, stock drawing\\n"); return false; }
    fprintf(stderr, "fast path: %d drawables, %d vertices, %d indices (%s)\\n", n, verts, idx, isz == 4 ? "32-bit" : "16-bit");
    return true;
}

/* this frame's positions, all drawables, in one upload */
static void csmFastUpload(const Live2D::Cubism::Framework::CubismModel &model) {
    using namespace csmfast;
    const int n = model.GetDrawableCount();
    for (int i = 0; i < n; i++)
        if (g.vtxCount[i]) memcpy(&g.staging[(size_t)g.vtxBase[i] * 2], model.GetDrawableVertices(i), (size_t)g.vtxCount[i] * 8);
    glBindBuffer(GL_ARRAY_BUFFER, g.vboPos);
    glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(g.staging.size() * 4), g.staging.data(), GL_STREAM_DRAW);
}
''')
rep('''    glEnable(GL_BLEND);
    glColorMask(1, 1, 1, 1);
''', '''    glEnable(GL_BLEND);
    glColorMask(1, 1, 1, 1);

    if (csmfast::g.on)
    {
        glBindVertexArray(csmfast::g.vao);   /* ours carries the index buffer; nothing to unbind */
        return;
    }
''')
rep('''    BeforeDrawModelRenderTarget();
    // モデル描画直前''', '''    {
        using csmfast::g;
        g.on = !g.failed && getenv("CUBISM_STOCK") == NULL && !GetModel()->IsBlendModeEnabled() &&
               GetModel()->GetOffscreenCount() == 0 && !IsUsingHighPrecisionMask();
        if (g.on && !g.built) { g.built = true; g.failed = !csmFastBuild(*GetModel()); g.on = !g.failed; }
        if (!g.on) g.uniforms.clear();   /* stock drawing sets uniforms behind the cache */
        if (g.on)
        {
            g.newFrame();
            const double u0 = csmfast::Now();
            csmFastUpload(*GetModel());
            g.tUpload += csmfast::Now() - u0;
            glBindVertexArray(g.vao);
            glFrontFace(GL_CCW);
        }
    }

    BeforeDrawModelRenderTarget();
    // モデル描画直前''')
rep('''    PostDraw();

    AfterDrawModelRenderTarget();
}''', '''    csmfast::Flush();   /* the last run (nothing waits when the fast path is off) */
    PostDraw();

    if (csmfast::g.on)
    {
        const double l0 = csmfast::Now();
        csmfast::EndFrame();
        csmfast::g.tLayout += csmfast::Now() - l0;
        csmfast::LogTiming();
        glBindVertexArray(0);
        glBindBuffer(GL_ARRAY_BUFFER, 0);
        glUseProgram(0);
        csmfast::g.on = false;
    }

    AfterDrawModelRenderTarget();
}''')
rep('''        return; // モデルが参照するテクスチャがバインドされていない場合は描画をスキップする
    }
#endif
''', '''        return; // モデルが参照するテクスチャがバインドされていない場合は描画をスキップする
    }
#endif

    if (csmfast::g.on)
    {
        using csmfast::g;
        csmfast::Cull(IsCulling());
        if (IsGeneratingMask())
            CubismShader_OpenGLES2::GetInstance()->SetupShaderProgramForMask(this, model, index);
        else
            CubismShader_OpenGLES2::GetInstance()->SetupShaderProgramForDrawable(this, model, index);
        csmfast::Draw(index, true);
        SetClippingContextBufferForDrawable(NULL);
        SetClippingContextBufferForMask(NULL);
        return;
    }
''')
# masks: a run waiting when the mask code switches framebuffer would land in the wrong one
s = s.replace('_currentMaskBuffer->EndDraw();', 'csmfast::Flush(); _currentMaskBuffer->EndDraw();')
if s.count('csmfast::Flush(); _currentMaskBuffer->EndDraw();') != 2:
    sys.exit('mask EndDraw anchors changed')
def rep_once(a, b):
    global s
    if s.count(a) != 1:
        sys.exit('anchor found %d times: %r' % (s.count(a), a[:80]))
    s = s.replace(a, b)
# timing: the drawables' loop, the masks, and the masks' bounds
rep_once('''    DrawObjectLoop(lastFBO, lastViewport);
''', '''    const double d0 = csmfast::Now();
    DrawObjectLoop(lastFBO, lastViewport);
    csmfast::Flush();
    csmfast::g.tLoop += csmfast::Now() - d0;
''')
rep_once('''            _drawableClippingManager->SetupClippingContext(*GetModel(), this, lastFBO, lastViewport, DrawableObjectType_Drawable);''',
'''            const double m0 = csmfast::Now(), b0 = csmfast::g.tBounds;
            _drawableClippingManager->SetupClippingContext(*GetModel(), this, lastFBO, lastViewport, DrawableObjectType_Drawable);
            csmfast::g.tMasks += csmfast::Now() - m0 - (csmfast::g.tBounds - b0);''')
rep_once('''    csmInt32 usingClipCount = 0;
    for (csmUint32 clipIndex = 0; clipIndex < _clippingContextListForMask.GetSize(); clipIndex++)
    {
        // １つのクリッピングマスクに関して
        CubismClippingContext_OpenGLES2* cc = _clippingContextListForMask[clipIndex];

        // このクリップを利用する描画オブジェクト群全体を囲む矩形を計算
        CalcClippedTotalBounds(model, cc, drawableObjectType);

        if (cc->_isUsing)
        {
            usingClipCount++; //使用中としてカウント
        }
    }
''', '''    csmInt32 usingClipCount = 0;
    const double cb0 = csmfast::Now();
    for (csmUint32 clipIndex = 0; clipIndex < _clippingContextListForMask.GetSize(); clipIndex++)
    {
        // １つのクリッピングマスクに関して
        CubismClippingContext_OpenGLES2* cc = _clippingContextListForMask[clipIndex];

        // このクリップを利用する描画オブジェクト群全体を囲む矩形を計算
        CalcClippedTotalBounds(model, cc, drawableObjectType);

        if (cc->_isUsing)
        {
            usingClipCount++; //使用中としてカウント
        }
    }
    csmfast::g.tBounds += csmfast::Now() - cb0;
''')
open('CubismRenderer_OpenGLES2.cpp', 'w', encoding='utf-8').write(s)

# the shader file: the per-draw GL calls go through the cache (it passes them through when the fast path is off)
s = open('CubismShader_OpenGLES2.cpp', encoding='utf-8').read()
rep('#include "CubismShader_OpenGLES2.hpp"\n', '#include "CubismShader_OpenGLES2.hpp"\n#include "csm_fast.hpp"\n')
CALLS = [('glUseProgram(', 'csmfast::UseProgram('), ('glActiveTexture(', 'csmfast::ActiveTexture('),
         ('glBindTexture(', 'csmfast::BindTexture('), ('glUniform1i(', 'csmfast::Uniform1i('),
         ('glUniform4f(', 'csmfast::Uniform4f('), ('glUniformMatrix4fv(', 'csmfast::UniformMatrix4fv('),
         ('glBlendFuncSeparate(', 'csmfast::BlendFuncSeparate(')]
a = s.index('void CubismShader_OpenGLES2::SetupShaderProgramForDrawable')
b = s.index('void CubismShader_OpenGLES2::SetupShaderProgramForOffscreenRenderTarget')
body = s[a:b]
for x, y in CALLS:
    body = body.replace(x, y)
s = s[:a] + body + s[b:]
rep('''    // 頂点位置属性の設定
    const csmFloat32* vertexArray''', '''    if (csmfast::g.on)
    {
        csmfast::Attrib(shaderSet->AttributePositionLocation, 1);
        csmfast::Attrib(shaderSet->AttributeTexCoordLocation, 2);
        return;
    }
    // 頂点位置属性の設定
    const csmFloat32* vertexArray''')
rep('''    const GLuint textureId = renderer->GetBindedTextureId(textureIndex);
    glActiveTexture(GL_TEXTURE0);''', '''    const GLuint textureId = renderer->GetBindedTextureId(textureIndex);
    if (csmfast::g.on)
    {
        /* the textures' parameters are set once when they load (chibi_live), the same values as these */
        csmfast::ActiveTexture(GL_TEXTURE0);
        csmfast::BindTexture(GL_TEXTURE_2D, textureId);
        csmfast::Uniform1i(shaderSet->SamplerTexture0Location, 0);
        return;
    }
    glActiveTexture(GL_TEXTURE0);''')
a = s.index('void CubismShader_OpenGLES2::SetColorUniformVariables')
s = s[:a] + s[a:].replace('glUniform4f(', 'csmfast::Uniform4f(')
open('CubismShader_OpenGLES2.cpp', 'w', encoding='utf-8').write(s)
print('applied')
