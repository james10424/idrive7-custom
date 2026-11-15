# SPDX-License-Identifier: MIT
# Copyright (C) 2026 James Zhao

# Build userland matching the head unit, as cluster-render's (Ubuntu 18.04
# amd64: gcc 7.5, glibc 2.27, the unit's libstdc++ ABI), with the OpenGL ES,
# EGL and GBM headers and link stubs; the unit's own Mesa 19 libraries are
# what run. Mesa's software renderer (llvmpipe) is here too, for trying the
# drawing off the car (make try, and the Mac bench with socat bridging its sockets).
FROM ubuntu:18.04@sha256:dca176c9663a7ba4c1f0e710986f5a25e672842963d95b960191e2d9f7185ebe
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      g++ make binutils python3 socat libgles2-mesa-dev libegl1-mesa-dev libgbm-dev libegl-mesa0 libgl1-mesa-dri >/dev/null \
 && rm -rf /var/lib/apt/lists/*
