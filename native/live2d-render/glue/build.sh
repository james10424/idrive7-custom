#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 James Zhao
#
# Builds live2d-render's Cubism glue into $OUT (default ../build/sdk):
# liblive2d-glue.so, Live2D's libLive2DCubismCore.so and the Framework's
# FrameworkShaders/, the folder you copy to the head unit by hand
# (README.md "The Cubism SDK"). Run by `make glue SDK=...` inside the build
# image, the SDK mounted at /sdk; never by a release.
set -e
SDK=${SDK:-/sdk}
OUT=${OUT:-../build/sdk}
OBJ=${OBJ:-../build/glue-obj}
FW=$SDK/Framework/src
[ -f "$FW/CubismFramework.hpp" ] || { echo "no Cubism SDK for Native at $SDK (SDK=...)" >&2; exit 2; }
CORE=$SDK/Core/dll/linux/x86_64/libLive2DCubismCore.so
[ -f "$CORE" ] || { echo "no $CORE" >&2; exit 2; }
mkdir -p "$OBJ/patched" "$OUT/FrameworkShaders"

# the renderer and its shaders' setup, patched (apply_fast.py: one vertex
# upload a frame, GL state only when it changes)
cp "$FW/Rendering/OpenGL/CubismRenderer_OpenGLES2.cpp" "$FW/Rendering/OpenGL/CubismShader_OpenGLES2.cpp" csm_fast.hpp "$OBJ/patched/"
(cd "$OBJ/patched" && python3 "$OLDPWD/apply_fast.py")

FLAGS="-std=c++14 -O2 -fPIC -fvisibility=hidden -DCSM_TARGET_HARMONYOS_ES3 -I$FW -I$FW/Rendering/OpenGL -I$SDK/Core/include"
SRCS=$(find "$FW" -name '*.cpp' | grep -v -E '/(D3D9|D3D11|Metal|Vulkan)/' | grep -v -E 'OpenGL/Cubism(Renderer|Shader)_OpenGLES2.cpp')
for f in $SRCS "$OBJ/patched/CubismRenderer_OpenGLES2.cpp" "$OBJ/patched/CubismShader_OpenGLES2.cpp"; do
  o=$OBJ/$(echo "$f" | sed 's|^[./]*||; s|/|_|g').o
  [ "$o" -nt "$f" ] || g++ $FLAGS -w -c "$f" -o "$o" &
done
wait
g++ $FLAGS -fvisibility=default -I. -c glue.cpp -o "$OBJ/glue.o"
cp "$CORE" "$OUT/"
g++ -shared -o "$OUT/liblive2d-glue.so" "$OBJ"/*.o -L"$OUT" -lLive2DCubismCore -lGLESv2 -ldl -lpthread \
    -Wl,-rpath,'$ORIGIN' -Wl,--no-undefined -Wl,-soname,liblive2d-glue.so
cp "$FW"/Rendering/OpenGL/Shaders/StandardES/*.vert "$FW"/Rendering/OpenGL/Shaders/StandardES/*.frag "$OUT/FrameworkShaders/"
echo "glue built: $OUT"
ls -la "$OUT"
