vec4 camera(float z, vec4 r0, vec4 r1) {
    float h = r0.w * pow(r1.w / r0.w, z);
    float along = (r0.w - h) / max(0.001, r0.w - r1.w);
    vec2 c = mix(r0.xy + r0.zw * 0.5, r1.xy + r1.zw * 0.5, along);
    vec2 wh = vec2(h * r0.z / r0.w, h);
    return vec4(c - wh * 0.5, wh);
}
