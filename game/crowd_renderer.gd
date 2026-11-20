extends Node2D

# The original player and weapons stay in their Godot world. Instance rows are
# sorted by ground Y, then split behind/in front of the player's own sprite.
const BODY_SHADER := """
shader_type canvas_item;
render_mode unshaded;
uniform float simulation_seconds;

void vertex() {
	float age = max(0.0, simulation_seconds - INSTANCE_CUSTOM.w);
	float phase = INSTANCE_CUSTOM.x;
	float frame = mod(floor(age * 6.0 + phase), 2.0);
	float u = mix(UV.x, 1.0 - UV.x, INSTANCE_CUSTOM.y);
	UV.x = (u + frame) * 0.25;
	UV.y = 1.0 - UV.y;
	VERTEX.y -= round(sin(fract(age * 2.6 + phase) * 3.14159265) * 3.0);
	if (INSTANCE_CUSTOM.z > 1.5) {
		COLOR.rgb *= 3.0;
	} else if (INSTANCE_CUSTOM.z > 0.5) {
		COLOR.rgb *= vec3(0.75, 0.85, 1.3);
	}
}
"""
const SHADOW_SHADER := """
shader_type canvas_item;
render_mode unshaded;
void vertex() {
	UV.y = 1.0 - UV.y;
}
"""

var game
var api
var batches: Array[MultiMesh] = []
var body_material: ShaderMaterial
var sprite_offset_y: float
var edge_margin: float
var previous_revision := -1
var previous_view := Rect2()

func setup(owner_game, capacity: int) -> void:
	game = owner_game
	api = JavaScriptBridge.get_interface("VSCrowd")
	var high_res := ResourceLoader.exists("res://assets/enemies/jjorang_hd.png")
	var body: Texture2D = Data.tex("res://assets/enemies/jjorang_hd.png" if high_res else "res://assets/enemies/jjorang.png")
	var shadow: Texture2D = Data.tex("res://assets/fx/shadow.png")
	var factor := 0.5 if high_res else 1.0
	var body_size := Vector2(body.get_width() * 0.25, body.get_height()) * factor
	sprite_offset_y = -30.0 * factor if high_res else -11.0
	edge_margin = maxf(body_size.length() * 0.5 + absf(sprite_offset_y) + 4.0, shadow.get_size().length())
	var shader := Shader.new()
	shader.code = BODY_SHADER
	body_material = ShaderMaterial.new()
	body_material.shader = shader
	physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	_add_batch(capacity, shadow, shadow.get_size() * Vector2(1.1, 1.0), -2, false)
	_add_batch(capacity, body, body_size, -1, true)
	_add_batch(capacity, body, body_size, 1, true)

func _add_batch(capacity: int, texture: Texture2D, size_world: Vector2, depth: int, body: bool) -> void:
	var quad := QuadMesh.new()
	quad.size = size_world
	var batch := MultiMesh.new()
	batch.transform_format = MultiMesh.TRANSFORM_2D
	batch.use_custom_data = body
	batch.mesh = quad
	batch.instance_count = capacity
	batch.visible_instance_count = 0
	var draw_node := MultiMeshInstance2D.new()
	draw_node.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	draw_node.z_index = depth
	draw_node.texture = texture
	draw_node.multimesh = batch
	if body:
		draw_node.material = body_material
	else:
		draw_node.self_modulate = Color(1.0, 1.0, 1.0, 0.55)
		var shadow_shader := Shader.new()
		shadow_shader.code = SHADOW_SHADER
		var shadow_material := ShaderMaterial.new()
		shadow_material.shader = shadow_shader
		draw_node.material = shadow_material
	add_child(draw_node)
	batches.append(batch)

func _process(_delta: float) -> void:
	if api == null or not is_instance_valid(game) or game.player == null:
		return
	var rect := get_viewport_rect()
	var to_world := get_canvas_transform().affine_inverse()
	var visible_rect := Rect2(to_world * rect.position, Vector2.ZERO).expand(to_world * rect.end)
	var revision: int = int(api.revision())
	if revision == previous_revision and visible_rect == previous_view:
		return
	var view_moved := previous_view != visible_rect
	previous_revision = revision
	previous_view = visible_rect
	var center := visible_rect.get_center()
	var half := visible_rect.size * 0.5
	api.prepareRender(center.x, center.y, half.x, half.y, game.player.global_position.y, sprite_offset_y, edge_margin)
	body_material.set_shader_parameter("simulation_seconds", float(api.clock()))
	var bounds := visible_rect.grow(edge_margin * 2.0)
	var world_bounds := AABB(Vector3(bounds.position.x, bounds.position.y, -1.0), Vector3(bounds.size.x, bounds.size.y, 2.0))
	for layer in batches.size():
		var mesh := batches[layer]
		var count: int = int(api.layerCount(layer))
		if view_moved:
			mesh.custom_aabb = world_bounds
		if count > 0:
			var bytes := JavaScriptBridge.js_buffer_to_packed_byte_array(api.layerBuffer(layer))
			RenderingServer.multimesh_set_buffer(mesh.get_rid(), bytes.to_float32_array())
		mesh.visible_instance_count = count
