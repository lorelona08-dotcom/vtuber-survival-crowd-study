extends Node2D

# Only the park debug wave uses the simple hostile 'hate' shot here. Native
# bosses retain their original eye-catching patterns, source callbacks and
# projectile nodes. The actual player still owns damage, cooldown and slow.
var api
var game
var batch := MultiMesh.new()
var margin := 16.0
var previous_revision := -1
var previous_view := Rect2()
var peak_step_us := 0
var hp_lost_to_wave := 0.0

func setup(world_game) -> void:
	game = world_game
	api = JavaScriptBridge.get_interface("VSProjectiles")
	api.reset()
	physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	var texture: Texture2D = Data.tex("res://assets/fx/hate.png")
	var quad := QuadMesh.new()
	quad.size = texture.get_size()
	margin = maxf(quad.size.x, quad.size.y) * 0.5 + 1.0
	batch.transform_format = MultiMesh.TRANSFORM_2D
	batch.mesh = quad
	var sprites := MultiMeshInstance2D.new()
	sprites.z_index = 6
	sprites.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	sprites.texture = texture
	# A 2D QuadMesh has the opposite vertical UV axis to the original Sprite2D.
	var shader := Shader.new()
	shader.code = "shader_type canvas_item; void vertex() { UV.y = 1.0 - UV.y; }"
	var material := ShaderMaterial.new()
	material.shader = shader
	sprites.material = material
	sprites.multimesh = batch
	add_child(sprites)

func add_wave(count: int, center: Vector2, start_index: int) -> void:
	api.spawnWave(count, center.x, center.y, start_index)

func clear_wave() -> void:
	api.clear()
	batch.visible_instance_count = 0

func advance(delta: float) -> void:
	if int(api.aliveCount()) == 0:
		return
	var started := Time.get_ticks_usec()
	var player = game.player
	var hit_buffer = api.step(delta, player.global_position.x, player.global_position.y, game.time_slow)
	var hits := JavaScriptBridge.js_buffer_to_packed_byte_array(hit_buffer).to_float32_array()
	if not hits.is_empty():
		# All shots in this batch use the same non-bypassing damage/slow.
		# Within one physics tick take_hit accepts at most the first; each
		# additional native apply_slow(0.6, 1.5) sets the same final timer.
		var before: float = player.hp
		if player._dmg_log:
			player.src_tag = "탄:hate"
		player.take_hit(hits[2], Vector2(hits[0], hits[1]), false)
		player.apply_slow(0.6, 1.5)
		hp_lost_to_wave += maxf(0.0, before - player.hp)
	peak_step_us = maxi(peak_step_us, Time.get_ticks_usec() - started)

func _process(_delta: float) -> void:
	if api == null:
		return
	var screen := get_viewport_rect()
	var to_world := get_canvas_transform().affine_inverse()
	var visible_rect := Rect2(to_world * screen.position, Vector2.ZERO).expand(to_world * screen.end)
	var revision := int(api.revision())
	if revision == previous_revision and visible_rect == previous_view:
		return
	if visible_rect != previous_view:
		var bounds := visible_rect.grow(margin)
		batch.custom_aabb = AABB(Vector3(bounds.position.x, bounds.position.y, -1.0), Vector3(bounds.size.x, bounds.size.y, 2.0))
	previous_revision = revision
	previous_view = visible_rect
	var center := visible_rect.get_center()
	var half := visible_rect.size * 0.5
	api.prepareRender(center.x, center.y, half.x, half.y, margin)
	var count := int(api.layerCount("hate"))
	var allocation := batch.instance_count
	if count > allocation or (count > 0 and count * 4 < allocation):
		allocation = maxi(32, nearest_po2(count))
		batch.instance_count = allocation
	if count > 0:
		var bytes := JavaScriptBridge.js_buffer_to_packed_byte_array(api.layerBuffer("hate", allocation))
		RenderingServer.multimesh_set_buffer(batch.get_rid(), bytes.to_float32_array())
	batch.visible_instance_count = count
