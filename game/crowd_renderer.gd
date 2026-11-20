extends Node2D

# The original player and weapons stay in their Godot world. Instance rows are
# sorted by ground Y, then split behind/in front of the player's own sprite.
const BODY_SHADER := """
shader_type canvas_item;
render_mode unshaded;
void vertex() {
	float frame = INSTANCE_CUSTOM.x;
	float u = mix(UV.x, 1.0 - UV.x, INSTANCE_CUSTOM.y);
	UV.x = (u + frame) * 0.25;
	UV.y = 1.0 - UV.y;
	VERTEX.y -= INSTANCE_CUSTOM.w;
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
var render_api
var batches: Array[MultiMesh] = []
var body_material: ShaderMaterial
var sprite_offset_y: float
var edge_margin: float
var previous_revision := -1
var previous_view := Rect2()

func setup(owner_game, capacity: int) -> void:
	game = owner_game
	api = JavaScriptBridge.get_interface("VSCrowd")
	render_api = JavaScriptBridge.get_interface("VSRender")
	var high_res := ResourceLoader.exists("res://assets/enemies/jjorang_hd.png")
	var body: Texture2D = Data.tex("res://assets/enemies/jjorang_hd.png" if high_res else "res://assets/enemies/jjorang.png")
	var shadow: Texture2D = Data.tex("res://assets/fx/shadow.png")
	var factor := 0.5 if high_res else 1.0
	var body_size := Vector2(body.get_width() * 0.25, body.get_height()) * factor
	var shadow_size := shadow.get_size() * Vector2(1.1, 1.0)
	sprite_offset_y = -30.0 * factor if high_res else -11.0
	edge_margin = maxf(body_size.length() * 0.5 + absf(sprite_offset_y) + 4.0, shadow.get_size().length())
	var pixels := body.get_image()
	if pixels != null and not pixels.is_empty():
		if pixels.is_compressed():
			pixels.decompress()
		pixels.convert(Image.FORMAT_RGBA8)
		var driver = render_api if render_api != null else api
		driver.configureAtlas(pixels.get_width(), pixels.get_height(), body_size.x, body_size.y,
			Marshalls.raw_to_base64(pixels.get_data()), shadow_size.x, shadow_size.y)
	var shader := Shader.new()
	shader.code = BODY_SHADER
	body_material = ShaderMaterial.new()
	body_material.shader = shader
	physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	set_meta("max_instances", capacity)
	_add_batch(shadow, shadow_size, -2, false)
	_add_batch(body, body_size, -1, true)
	_add_batch(body, body_size, 1, true)

func _add_batch(texture: Texture2D, size_world: Vector2, depth: int, body: bool) -> void:
	var quad := QuadMesh.new()
	quad.size = size_world
	var batch := MultiMesh.new()
	batch.transform_format = MultiMesh.TRANSFORM_2D
	batch.use_custom_data = body
	batch.mesh = quad
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
	if render_api == null and revision == previous_revision and visible_rect == previous_view:
		return
	var view_moved := previous_view != visible_rect
	var center := visible_rect.get_center()
	var half := visible_rect.size * 0.5
	var raster_size := get_viewport().get_texture().get_size()
	var pitch_x := visible_rect.size.x / maxf(raster_size.x, 1.0)
	var pitch_y := visible_rect.size.y / maxf(raster_size.y, 1.0)
	var driver = render_api if render_api != null else api
	if render_api != null:
		if not bool(render_api.prepare(center.x, center.y, half.x, half.y, game.player.global_position.y, sprite_offset_y, edge_margin, pitch_x, pitch_y)):
			return
	else:
		api.prepareRender(center.x, center.y, half.x, half.y, game.player.global_position.y, sprite_offset_y, edge_margin, pitch_x, pitch_y)
	previous_revision = revision
	previous_view = visible_rect
	var bounds := visible_rect.grow(edge_margin * 2.0)
	var world_bounds := AABB(Vector3(bounds.position.x, bounds.position.y, -1.0), Vector3(bounds.size.x, bounds.size.y, 2.0))
	for layer in batches.size():
		var mesh := batches[layer]
		var count: int = int(driver.layerCount(layer))
		# Upload only the prefix occupied by this layer. Spare slots amortize
		# scene changes; they do not multiply transfer cost by the total swarm.
		var allocated := mesh.instance_count
		if count > allocated or (count > 0 and count * 4 < allocated):
			allocated = mini(int(get_meta("max_instances")), maxi(32, nearest_po2(count)))
			mesh.instance_count = allocated
		if view_moved:
			mesh.custom_aabb = world_bounds
		if count > 0:
			var bytes := JavaScriptBridge.js_buffer_to_packed_byte_array(driver.layerBuffer(layer, allocated))
			RenderingServer.multimesh_set_buffer(mesh.get_rid(), bytes.to_float32_array())
		mesh.visible_instance_count = count
