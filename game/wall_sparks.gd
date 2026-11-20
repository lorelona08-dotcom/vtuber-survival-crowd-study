extends MultiMeshInstance2D

# The three primitives of each original spark keep their inner draw order in
# one instance. As a child of game.fx this uses the same world transform and Z.
const WALL_SHADER := """
shader_type canvas_item;
render_mode unshaded;
uniform vec4 spark_tint : source_color = vec4(0.85, 0.75, 0.6, 1.0);
void vertex() {
    float part = UV.x;
    float fade = INSTANCE_CUSTOM.z;
    if (part < 0.25) {
        vec2 tail = INSTANCE_CUSTOM.xy;
        vec2 side = vec2(-tail.y, tail.x) / max(length(tail), 0.000001);
        VERTEX = tail * (VERTEX.x - 0.5) + side * VERTEX.y;
        COLOR *= vec4(spark_tint.rgb, fade * 0.55);
    } else if (part < 0.75) {
        VERTEX *= 1.5;
        COLOR *= vec4(spark_tint.rgb, fade);
    } else {
        VERTEX *= 0.5;
        COLOR *= vec4(1.0, 1.0, 1.0, fade);
    }
}
"""

var api
var uniforms := PackedFloat64Array()
var last_bounds := Rect2()

func setup() -> void:
	api = JavaScriptBridge.get_interface("VSWallSparks")
	api.reset()
	physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	var shader := Shader.new()
	shader.code = WALL_SHADER
	var shader_material := ShaderMaterial.new()
	shader_material.shader = shader
	material = shader_material
	var batch := MultiMesh.new()
	batch.transform_format = MultiMesh.TRANSFORM_2D
	batch.use_custom_data = true
	batch.mesh = _spark_mesh()
	multimesh = batch
	set_process(false)

func _spark_mesh() -> ArrayMesh:
	var vertices := PackedVector3Array()
	var tags := PackedVector2Array()
	var indices := PackedInt32Array()
	for part in 3:
		for corner in [Vector2(-0.5, -0.5), Vector2(0.5, -0.5), Vector2(0.5, 0.5), Vector2(-0.5, 0.5)]:
			vertices.append(Vector3(corner.x, corner.y, 0))
			tags.append(Vector2(float(part) * 0.5, 0))
		for index in [0, 1, 2, 0, 2, 3]:
			indices.append(part * 4 + index)
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_TEX_UV] = tags
	arrays[Mesh.ARRAY_INDEX] = indices
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh

func take_impacts(words: int) -> int:
	if words <= 0:
		return 0
	var particles := (words >> 1) * 3
	uniforms.resize(particles * 3)
	for i in particles:
		# Match the upstream global RNG calls, including randf_range's use of
		# doubles. Other gameplay consuming the same RNG keeps its sequence.
		var angle := randf() * TAU
		var velocity := Vector2.from_angle(angle) * 30.0 * randf_range(0.5, 1.2)
		uniforms[3 * i] = velocity.x
		uniforms[3 * i + 1] = velocity.y
		uniforms[3 * i + 2] = 0.2 * randf_range(0.7, 1.2)
	# Godot 4.7's JS interface accepts strings as outbound values. Return to JS
	# once per contact batch; impact positions remain in the shot pool throughout.
	var added := int(api.takeImpacts(Marshalls.raw_to_base64(uniforms.to_byte_array())))
	if added > 0:
		set_process(true)
	return added

func _process(delta: float) -> void:
	if api == null:
		return
	var rect := get_viewport_rect()
	var to_world := get_canvas_transform().affine_inverse()
	var bounds := Rect2(to_world * rect.position, Vector2.ZERO).expand(to_world * rect.end).grow(3.0)
	if last_bounds != bounds:
		multimesh.custom_aabb = AABB(Vector3(bounds.position.x, bounds.position.y, -1), Vector3(bounds.size.x, bounds.size.y, 2))
		last_bounds = bounds
	var count := int(api.advance(delta, bounds.position.x, bounds.position.y, bounds.end.x, bounds.end.y))
	var allocated := multimesh.instance_count
	if count > allocated or (count > 0 and count * 4 < allocated):
		allocated = maxi(32, nearest_po2(count)) if count <= 1024 else ceili(count / 1024.0) * 1024
		multimesh.instance_count = allocated
	if count:
		var bytes := JavaScriptBridge.js_buffer_to_packed_byte_array(api.buffer(allocated))
		RenderingServer.multimesh_set_buffer(multimesh.get_rid(), bytes.to_float32_array())
	multimesh.visible_instance_count = count
	if int(api.count) == 0:
		set_process(false)

func audit() -> Dictionary:
	return {"impacts": int(api.impacts), "spawned": int(api.spawned), "active": int(api.count), "expired": int(api.expired),
		"submitted": int(api.submitted), "peakActive": int(api.peak)}
