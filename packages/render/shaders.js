export const bitmapComputeWgsl = /* wgsl */ `
struct Job {
  dataOffset: u32, stride: u32, width: u32, height: u32,
  bpp: u32, bottomUp: u32, dstX: u32, dstY: u32,
  drawWidth: u32, drawHeight: u32, pad0: u32, pad1: u32,
};
struct Batch { first: u32, count: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read> packed: array<u32>;
@group(0) @binding(1) var<storage, read> jobs: array<Job>;
@group(0) @binding(2) var desktop: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read> palette: array<u32>;
@group(0) @binding(4) var<uniform> batch: Batch;
fn byteAt(index: u32) -> u32 { return (packed[index >> 2u] >> ((index & 3u) * 8u)) & 255u; }
fn expand5(v: u32) -> u32 { return (v << 3u) | (v >> 2u); }
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.z >= batch.count) { return; }
  let job = jobs[batch.first + id.z];
  if (id.x >= job.drawWidth || id.y >= job.drawHeight) { return; }
  let row = select(id.y, job.height - 1u - id.y, job.bottomUp != 0u);
  let offset = job.dataOffset + row * job.stride + id.x * ((job.bpp + 7u) >> 3u);
  var rgb: vec3<u32>;
  if (job.bpp == 8u) {
    let c = palette[byteAt(offset)]; rgb = vec3<u32>(c & 255u, (c >> 8u) & 255u, (c >> 16u) & 255u);
  } else if (job.bpp == 15u || job.bpp == 16u) {
    let p = byteAt(offset) | (byteAt(offset + 1u) << 8u);
    if (job.bpp == 16u) { let g = (p >> 5u) & 63u; rgb = vec3<u32>(expand5((p >> 11u) & 31u), (g << 2u) | (g >> 4u), expand5(p & 31u)); }
    else { rgb = vec3<u32>(expand5((p >> 10u) & 31u), expand5((p >> 5u) & 31u), expand5(p & 31u)); }
  } else { rgb = vec3<u32>(byteAt(offset + 2u), byteAt(offset + 1u), byteAt(offset)); }
  textureStore(desktop, vec2<i32>(i32(job.dstX + id.x), i32(job.dstY + id.y)), vec4<f32>(vec3<f32>(rgb) / 255.0, 1.0));
}
`;
export const presentWgsl = /* wgsl */ `
struct View { size: vec2<u32>, position: vec2<i32>, hotspot: vec2<i32>, cursorSize: vec2<u32>, mode: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var desktop: texture_2d<f32>;
@group(0) @binding(1) var cursorImage: texture_2d<u32>;
@group(0) @binding(2) var<uniform> view: View;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}
@fragment fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(position.xy); var color = textureLoad(desktop, p, 0).rgb;
  let c = p - view.position + view.hotspot;
  if (view.mode != 0u && all(c >= vec2<i32>(0)) && all(c < vec2<i32>(view.cursorSize))) {
    let pixel = textureLoad(cursorImage, c, 0);
    if (view.mode == 1u) { let base = vec3<u32>(round(color * 255.0)); color = vec3<f32>((base & vec3<u32>(pixel.a)) ^ pixel.rgb) / 255.0; }
    else { color = mix(color, vec3<f32>(pixel.rgb) / 255.0, f32(pixel.a) / 255.0); }
  }
  return vec4<f32>(color, 1.0);
}
`;
export const glVertex = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }
`;
export const glFragment = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D desktop;
uniform sampler2D cursorImage;
uniform ivec2 desktopSize;
uniform ivec2 cursorPosition;
uniform ivec2 hotspot;
uniform ivec2 cursorSize;
uniform int cursorMode;
out vec4 outputColor;
void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), desktopSize.y - 1 - int(gl_FragCoord.y));
  vec3 color = texelFetch(desktop, p, 0).rgb;
  ivec2 c = p - cursorPosition + hotspot;
  if (cursorMode != 0 && all(greaterThanEqual(c, ivec2(0))) && all(lessThan(c, cursorSize))) {
    uvec4 pixel = uvec4(round(texelFetch(cursorImage, c, 0) * 255.0));
    if (cursorMode == 1) { uvec3 base = uvec3(round(color * 255.0)); color = vec3((base & uvec3(pixel.a)) ^ pixel.rgb) / 255.0; }
    else color = mix(color, vec3(pixel.rgb) / 255.0, float(pixel.a) / 255.0);
  }
  outputColor = vec4(color, 1.0);
}
`;
