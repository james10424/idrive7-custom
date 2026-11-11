// Atlas text for a cluster-render "effect" layer (GLSL ES 1.00): u_cells equal cells across the layer, each
// showing one glyph of the R8 glyph atlas bound to u_font (u_grid.x columns by u_grid.y rows of cells), picked
// by the codes in u_text (32 codes, 4 to a vec4; below 0 = empty). A new value is one uniform message, no
// pixels. After robertnisipeanu/idrive-apps js/showcase.js (TEXT_FS). v_uv (0,0) is the top-left.
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_font;
uniform vec4 u_text[8];
uniform float u_cells;
uniform vec2 u_grid;
uniform vec4 u_color;

float code(float cell) {
    float slot = floor(cell / 4.0), lane = cell - slot * 4.0;
    vec4 v = u_text[0];
    for (int i = 1; i < 8; i++) if (float(i) == slot) v = u_text[i];
    return lane < 0.5 ? v.x : lane < 1.5 ? v.y : lane < 2.5 ? v.z : v.w;
}

void main() {
    float x = v_uv.x * u_cells;
    float c = code(floor(x));
    float col = mod(c, u_grid.x), row = floor(c / u_grid.x);
    vec2 uv = vec2((col + fract(x)) / u_grid.x, (row + v_uv.y) / u_grid.y);
    float ink = c < 0.0 ? 0.0 : texture2D(u_font, uv).r;
    gl_FragColor = vec4(u_color.rgb, u_color.a * ink);
}
