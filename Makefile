roms := \
	pokered.gbc \
	pokeblue.gbc \
	pokeblue_debug.gbc
patches := \
	pokered.patch \
	pokeblue.patch
web_dist := dist/web
web_assets := $(web_dist)/assets
web_sources := \
	web/player.html \
	web/player.css \
	web/player.js
web_bundle := \
	$(web_dist)/player.html \
	$(web_dist)/player.css \
	$(web_dist)/player.js \
	$(web_assets)/pokered.gbc \
	$(web_assets)/binjgb.js \
	$(web_assets)/binjgb.wasm \
	$(web_assets)/version.json \
	$(web_dist)/NOTICE.binjgb.txt
binjgb_dir := third_party/binjgb
binjgb_build_dir := web/.build/binjgb
binjgb_emscripten_cmake ?=
web_app_version ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo local)
binjgb_version := $(shell git -C $(binjgb_dir) describe --tags --always 2>/dev/null || echo unknown)

rom_obj := \
	audio.o \
	home.o \
	main.o \
	maps.o \
	ram.o \
	text.o \
	gfx/pics.o \
	gfx/sprites.o \
	gfx/tilesets.o

pokered_obj        := $(rom_obj:.o=_red.o)
pokeblue_obj       := $(rom_obj:.o=_blue.o)
pokeblue_debug_obj := $(rom_obj:.o=_blue_debug.o)
pokered_vc_obj     := $(rom_obj:.o=_red_vc.o)
pokeblue_vc_obj    := $(rom_obj:.o=_blue_vc.o)


### Build tools

ifeq (,$(shell which sha1sum))
SHA1 := shasum
else
SHA1 := sha1sum
endif

RGBDS ?=
RGBASM  ?= $(RGBDS)rgbasm
RGBFIX  ?= $(RGBDS)rgbfix
RGBGFX  ?= $(RGBDS)rgbgfx
RGBLINK ?= $(RGBDS)rgblink


### Build targets

.SUFFIXES:
.SECONDEXPANSION:
.PRECIOUS:
.SECONDARY:
.PHONY: all red blue blue_debug clean tidy compare tools web serve-web clean-web

all: $(roms)
red:        pokered.gbc
blue:       pokeblue.gbc
blue_debug: pokeblue_debug.gbc
red_vc:     pokered.patch
blue_vc:    pokeblue.patch
web:        $(web_bundle)
serve-web:  web

clean: tidy
	find gfx \
	     \( -iname '*.1bpp' \
	        -o -iname '*.2bpp' \
	        -o -iname '*.pic' \) \
	     -delete

tidy: clean-web
	$(RM) $(roms) \
	      $(roms:.gbc=.sym) \
	      $(roms:.gbc=.map) \
	      $(patches) \
	      $(patches:.patch=_vc.gbc) \
	      $(patches:.patch=_vc.sym) \
	      $(patches:.patch=_vc.map) \
	      $(patches:%.patch=vc/%.constants.sym) \
	      $(pokered_obj) \
	      $(pokeblue_obj) \
	      $(pokered_vc_obj) \
	      $(pokeblue_vc_obj) \
	      $(pokeblue_debug_obj) \
	      rgbdscheck.o
	$(MAKE) clean -C tools/

clean-web:
	rm -rf $(web_dist) web/.build

compare: $(roms) $(patches)
	@$(SHA1) -c roms.sha1

tools:
	$(MAKE) -C tools/

serve-web:
	python3 -m http.server --directory $(web_dist) 8000


RGBASMFLAGS = -Q8 -P includes.asm -Weverything -Wtruncation=1
# Create a sym/map for debug purposes if `make` run with `DEBUG=1`
ifeq ($(DEBUG),1)
RGBASMFLAGS += -E
endif

$(pokered_obj):        RGBASMFLAGS += -D _RED
$(pokeblue_obj):       RGBASMFLAGS += -D _BLUE
$(pokeblue_debug_obj): RGBASMFLAGS += -D _BLUE -D _DEBUG
$(pokered_vc_obj):     RGBASMFLAGS += -D _RED -D _RED_VC
$(pokeblue_vc_obj):    RGBASMFLAGS += -D _BLUE -D _BLUE_VC

%.patch: vc/%.constants.sym %_vc.gbc %.gbc vc/%.patch.template
	tools/make_patch $*_vc.sym $^ $@

rgbdscheck.o: rgbdscheck.asm
	$(RGBASM) -o $@ $<

# Build tools when building the rom.
# This has to happen before the rules are processed, since that's when scan_includes is run.
ifeq (,$(filter clean tidy tools,$(MAKECMDGOALS)))

$(info $(shell $(MAKE) -C tools))

# The dep rules have to be explicit or else missing files won't be reported.
# As a side effect, they're evaluated immediately instead of when the rule is invoked.
# It doesn't look like $(shell) can be deferred so there might not be a better way.
preinclude_deps := includes.asm $(shell tools/scan_includes includes.asm)
define DEP
$1: $2 $$(shell tools/scan_includes $2) $(preinclude_deps) | rgbdscheck.o
	$$(RGBASM) $$(RGBASMFLAGS) -o $$@ $$<
endef

# Dependencies for objects (drop _red and _blue from asm file basenames)
$(foreach obj, $(pokered_obj), $(eval $(call DEP,$(obj),$(obj:_red.o=.asm))))
$(foreach obj, $(pokeblue_obj), $(eval $(call DEP,$(obj),$(obj:_blue.o=.asm))))
$(foreach obj, $(pokeblue_debug_obj), $(eval $(call DEP,$(obj),$(obj:_blue_debug.o=.asm))))
$(foreach obj, $(pokered_vc_obj), $(eval $(call DEP,$(obj),$(obj:_red_vc.o=.asm))))
$(foreach obj, $(pokeblue_vc_obj), $(eval $(call DEP,$(obj),$(obj:_blue_vc.o=.asm))))

# Dependencies for VC files that need to run scan_includes
%.constants.sym: %.constants.asm $(shell tools/scan_includes %.constants.asm) $(preinclude_deps) | rgbdscheck.o
	$(RGBASM) $(RGBASMFLAGS) $< > $@

endif


%.asm: ;


pokered_pad        = 0x00
pokeblue_pad       = 0x00
pokered_vc_pad     = 0x00
pokeblue_vc_pad    = 0x00
pokeblue_debug_pad = 0xff

pokered_opt        = -Cjv -n 0 -k 01 -l 0x33 -m 0x13 -r 03 -t "POKEMON RED"
pokeblue_opt       = -Cjv -n 0 -k 01 -l 0x33 -m 0x13 -r 03 -t "POKEMON BLUE"
pokeblue_debug_opt = -Cjv -n 0 -k 01 -l 0x33 -m 0x13 -r 03 -t "POKEMON BLUE"
pokered_vc_opt     = -Cjv -n 0 -k 01 -l 0x33 -m 0x13 -r 03 -t "POKEMON RED"
pokeblue_vc_opt    = -Cjv -n 0 -k 01 -l 0x33 -m 0x13 -r 03 -t "POKEMON BLUE"

%.gbc: $$(%_obj) layout.link
	$(RGBLINK) -p $($*_pad) -d -m $*.map -n $*.sym -l layout.link -o $@ $(filter %.o,$^)
	$(RGBFIX) -p $($*_pad) $($*_opt) $@


### Misc file-specific graphics rules

gfx/battle/move_anim_0.2bpp: tools/gfx += --trim-whitespace
gfx/battle/move_anim_1.2bpp: tools/gfx += --trim-whitespace

gfx/intro/blue_jigglypuff_1.2bpp: rgbgfx += -Z
gfx/intro/blue_jigglypuff_2.2bpp: rgbgfx += -Z
gfx/intro/blue_jigglypuff_3.2bpp: rgbgfx += -Z
gfx/intro/red_nidorino_1.2bpp: rgbgfx += -Z
gfx/intro/red_nidorino_2.2bpp: rgbgfx += -Z
gfx/intro/red_nidorino_3.2bpp: rgbgfx += -Z
gfx/intro/gengar.2bpp: rgbgfx += -Z
gfx/intro/gengar.2bpp: tools/gfx += --remove-duplicates --preserve=0x19,0x76

gfx/credits/the_end.2bpp: tools/gfx += --interleave --png=$<

gfx/slots/red_slots_1.2bpp: tools/gfx += --trim-whitespace
gfx/slots/blue_slots_1.2bpp: tools/gfx += --trim-whitespace

gfx/tilesets/%.2bpp: tools/gfx += --trim-whitespace
gfx/tilesets/reds_house.2bpp: tools/gfx += --preserve=0x48

gfx/trade/game_boy.2bpp: tools/gfx += --remove-duplicates


### Catch-all graphics rules

%.png: ;

%.2bpp: %.png
	$(RGBGFX) $(rgbgfx) -o $@ $<
	$(if $(tools/gfx),\
		tools/gfx $(tools/gfx) -o $@ $@)

%.1bpp: %.png
	$(RGBGFX) $(rgbgfx) -d1 -o $@ $<
	$(if $(tools/gfx),\
		tools/gfx $(tools/gfx) -d1 -o $@ $@)

%.pic: %.2bpp
	tools/pkmncompress $< $@


### Web bundle rules

$(web_dist) $(web_assets) $(binjgb_build_dir):
	mkdir -p $@

$(binjgb_build_dir)/.prepared: Makefile $(binjgb_dir) web/binjgb/exported.json web/binjgb/wrapper.c | $(binjgb_build_dir)
	rm -rf $(binjgb_build_dir)
	mkdir -p $(binjgb_build_dir)
	git -C $(binjgb_dir) archive --format=tar HEAD | tar -xf - -C $(binjgb_build_dir)
	perl -0pi -e 's/cmake_minimum_required\(VERSION 2\.8\)/cmake_minimum_required(VERSION 3.5)/' $(binjgb_build_dir)/CMakeLists.txt
	cp web/binjgb/exported.json $(binjgb_build_dir)/src/emscripten/exported.json
	cp web/binjgb/wrapper.c $(binjgb_build_dir)/src/emscripten/wrapper.c
	touch $@

$(binjgb_build_dir)/.demo-built: $(binjgb_build_dir)/.prepared
	$(MAKE) -C $(binjgb_build_dir) demo $(if $(binjgb_emscripten_cmake),EMSCRIPTEN_CMAKE=$(binjgb_emscripten_cmake))
	touch $@

$(binjgb_build_dir)/docs/binjgb.js: $(binjgb_build_dir)/.demo-built
	cp $(binjgb_build_dir)/out/Wasm/binjgb.js $@

$(binjgb_build_dir)/docs/binjgb.wasm: $(binjgb_build_dir)/.demo-built
	cp $(binjgb_build_dir)/out/Wasm/binjgb.wasm $@

$(web_dist)/player.html: web/player.html | $(web_dist)
	cp $< $@

$(web_dist)/player.css: web/player.css | $(web_dist)
	cp $< $@

$(web_dist)/player.js: web/player.js | $(web_dist)
	cp $< $@

$(web_assets)/pokered.gbc: pokered.gbc | $(web_assets)
	cp $< $@

$(web_assets)/binjgb.js: $(binjgb_build_dir)/docs/binjgb.js | $(web_assets)
	cp $< $@

$(web_assets)/binjgb.wasm: $(binjgb_build_dir)/docs/binjgb.wasm | $(web_assets)
	cp $< $@

$(web_dist)/NOTICE.binjgb.txt: $(binjgb_dir)/LICENSE | $(web_dist)
	cp $< $@

$(web_assets)/version.json: $(web_assets)/pokered.gbc | $(web_assets)
	@rom_sha="$$( $(SHA1) $< | awk '{print $$1}' )"; \
	printf '{\n  "rom": "pokered.gbc",\n  "romSha1": "%s",\n  "appVersion": "%s",\n  "emulatorVersion": "%s"\n}\n' "$$rom_sha" "$(web_app_version)" "$(binjgb_version)" > $@
