# SPDX-License-Identifier: MIT
# Copyright (C) 2026 James Zhao

# live2d-render: draws a Live2D model on the head unit's GPU with the
# parameter values an app sends, as a cluster-render video layer (README.md).
#
#   make test                 the host tests: the control messages and the crash guard
#   make target               build/target/live2d-render for the head unit, built in
#                             Docker (Ubuntu 18.04 amd64, as cluster-render's)
#   make prebuilt             that, copied to prebuilt/live2d-render: what the Store
#                             installs (the head unit builds no native code; commit it)
#   make glue SDK=<folder>    build/sdk: the Cubism glue library, Live2D's Core and
#                             the Framework's shaders, from your copy of Cubism SDK for
#                             Native 5-r.5; copied to the head unit by hand, never
#                             released (README.md "The Cubism SDK")
#   make try MODEL=<model3.json> FRAME="cx cy height" [HIDE=...] [PARAMS=...]
#                             (after make glue) the target, then a few seconds of drawing on Mesa's software
#                             renderer in Docker, the frames compared with the CPU's
#                             4:2:0 and saved to build/try/
#   make deploy-sdk CAR=root@<ip>   build/sdk to the head unit's /var/opt/live2d-render/sdk

CXX     ?= c++
BUILD   ?= build
JOBS    ?= $(shell nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)
CR      := third_party/cluster_render
IMAGE   := live2d-render-build:$(shell cksum < docker/Dockerfile | cut -d' ' -f1)
DOCKER_IMAGE = docker image inspect $(IMAGE) >/dev/null 2>&1 || docker build -q --platform linux/amd64 -t $(IMAGE) docker
DOCKER_RUN = docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/w/live2d-render" -w /w/live2d-render

VERSION := $(shell sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' component.json)
CXXFLAGS = -std=c++14 -O2 -Wall -Wextra -Werror -Isrc -I$(CR)/include -DLIVE2D_RENDER_VERSION='"$(VERSION)"'
T = $(BUILD)/target
H = $(BUILD)/host

SRC = src/main.cpp src/gpu.cpp src/guard.cpp src/control.cpp $(CR)/client/client.cpp $(CR)/client/protocol.cpp
HDR = $(wildcard src/*.h) $(wildcard $(CR)/include/cluster_render/*.h)

.PHONY: all test target target-in-docker prebuilt glue glue-in-docker try deploy-sdk clean

all: test

# ---- host tests ---------------------------------------------------------------
$(H)/control_test: test/control_test.cpp src/control.cpp $(CR)/client/protocol.cpp $(HDR)
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -o $@ test/control_test.cpp src/control.cpp $(CR)/client/protocol.cpp

$(H)/guard_test: test/guard_test.cpp src/guard.cpp src/guard.h
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -o $@ test/guard_test.cpp src/guard.cpp

test: $(H)/control_test $(H)/guard_test
	$(H)/control_test
	$(H)/guard_test $(H)

# ---- the head unit's binary -----------------------------------------------------
target:
	$(DOCKER_IMAGE)
	$(DOCKER_RUN) $(IMAGE) make -s BUILD=$(BUILD) target-in-docker

# The unit has its loader in /lib only; its Mesa 19 libEGL, libGLESv2 and libgbm.
target-in-docker: $(T)/live2d-render

$(T)/live2d-render: $(SRC) $(HDR)
	@mkdir -p $(@D)
	g++ $(CXXFLAGS) -o $@ $(SRC) -lEGL -lGLESv2 -lgbm -ldl -pthread -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2
	@readelf -d $@ | grep NEEDED | sed 's/.*\[\(.*\)\]/  needs \1/'

prebuilt: target
	mkdir -p prebuilt
	cp $(T)/live2d-render prebuilt/live2d-render
	@echo "prebuilt/live2d-render updated: commit it, with component.json's version raised"

# ---- the Cubism glue (never released) -------------------------------------------
glue:
	@[ -n "$(SDK)" ] && [ -f "$(SDK)/Framework/src/CubismFramework.hpp" ] || { echo "SDK=<your Cubism SDK for Native folder>"; exit 2; }
	$(DOCKER_IMAGE)
	$(DOCKER_RUN) -v "$(abspath $(SDK)):/sdk:ro" -w /w/live2d-render/glue $(IMAGE) \
		env SDK=/sdk OUT=../$(BUILD)/sdk OBJ=../$(BUILD)/glue-obj sh build.sh

# ---- trying it off the car ------------------------------------------------------
try: target
	@[ -n "$(MODEL)" ] && [ -n "$(FRAME)" ] || { echo 'MODEL=<model3.json> FRAME="cx cy height"'; exit 2; }
	@[ -f $(BUILD)/sdk/liblive2d-glue.so ] || { echo "make glue SDK=... first"; exit 2; }
	@mkdir -p $(BUILD)/try
	$(DOCKER_RUN) -v "$(abspath $(dir $(MODEL))):/model:ro" $(IMAGE) \
		python3 tools/try.py --bin $(T)/live2d-render --sdk $(BUILD)/sdk --model /model/$(notdir $(MODEL)) \
		--frame "$(FRAME)" --hide "$(HIDE)" --params "$(PARAMS)" --out $(BUILD)/try $(if $(SCRIPT),--script $(SCRIPT))

deploy-sdk:
	@[ -n "$(CAR)" ] && [ -f $(BUILD)/sdk/liblive2d-glue.so ] || { echo "make glue first; CAR=root@<ip>"; exit 2; }
	ssh $(CAR) 'mkdir -p /var/opt/live2d-render/sdk/FrameworkShaders'
	scp $(BUILD)/sdk/liblive2d-glue.so $(BUILD)/sdk/libLive2DCubismCore.so $(CAR):/var/opt/live2d-render/sdk/
	scp $(BUILD)/sdk/FrameworkShaders/* $(CAR):/var/opt/live2d-render/sdk/FrameworkShaders/

clean:
	rm -rf $(BUILD)
