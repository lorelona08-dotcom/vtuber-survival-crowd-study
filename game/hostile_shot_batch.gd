extends Node2D

# Only the park debug wave uses the simple hostile 'hate' shot here. Native
# bosses retain their original eye-catching patterns, source callbacks and
# projectile nodes. The actual player still owns damage, cooldown and slow.
var api
var game
var wall_sparks
var batch := MultiMesh.new()
var margin := 16.0
var previous_revision := -1
var previous_view := Rect2()
var peak_step_us := 0
var hp_lost_to_wave := 0.0
var opaque_odd_sprite := false

func setup(world_game) -> void:
	game = world_game
	api = JavaScriptBridge.get_interface("VSProjectiles")
	api.reset()
	var review = JavaScriptBridge.get_interface("VSReview")
	if str(review.wallFx) == "batch" and str(review.preset) == "mixed":
		wall_sparks = preload("res://review/wall_sparks.gd").new()
		game.fx.add_child(wall_sparks)
		wall_sparks.setup()
	physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	var texture: Texture2D = Data.tex("res://assets/fx/hate.png")
	var image := texture.get_image()
	if image.is_compressed():
		image.decompress()
	image.convert(Image.FORMAT_RGBA8)
	opaque_odd_sprite = image.get_width() % 2 == 1 and image.get_height() % 2 == 1 \
		and ProjectSettings.get_setting("rendering/2d/snap/snap_2d_vertices_to_pixel", false) \
		and ProjectSettings.get_setting("rendering/2d/snap/snap_2d_transforms_to_pixel", false)
	var rgba := image.get_data()
	for i in range(3, rgba.size(), 4):
		if rgba[i] > 0 and rgba[i] < 255:
			opaque_odd_sprite = false
			break
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

func wall_spark_stats() -> Dictionary:
	return wall_sparks.audit() if is_instance_valid(wall_sparks) else {}

func advance(delta: float) -> void:
	if int(api.aliveCount()) == 0:
		return
	var started := Time.get_ticks_usec()
	var player = game.player
	# This pool is exclusively the identical debug shot. Every contact is still
	# resolved and counted in the pool. Only the first one can defeat the
	# player's shared damage cooldown this tick, and every slow is identical.
	var hit_buffer = api.step(delta, player.global_position.x, player.global_position.y, game.time_slow, true)
	if int(api.wallWords) > 0:
		if is_instance_valid(wall_sparks):
			wall_sparks.take_impacts(int(api.wallWords))
		else:
			var points := JavaScriptBridge.js_buffer_to_packed_byte_array(api.wallImpactPositions()).to_float32_array()
			for i in range(0, points.size(), 2):
				game.fx.sparks(Vector2(points[i], points[i + 1]), Color(0.85, 0.75, 0.6), 3, 30, 0.2)
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
	var native_pixels := get_viewport().get_texture().get_size().is_equal_approx(visible_rect.size)
	api.prepareRender(center.x, center.y, half.x, half.y, margin, opaque_odd_sprite and native_pixels)
	var count := int(api.layerCount("hate"))
	var allocation := batch.instance_count
	if count > allocation or (count > 0 and count * 4 < allocation):
		# RenderingServer requires one transform for every allocated slot. Keep
		# large stable waves in 1024-slot blocks to bound padding on each upload.
		allocation = maxi(32, nearest_po2(count)) if count <= 1024 else ceili(count / 1024.0) * 1024
		batch.instance_count = allocation
	if count > 0:
		var bytes := JavaScriptBridge.js_buffer_to_packed_byte_array(api.layerBuffer("hate", allocation))
		RenderingServer.multimesh_set_buffer(batch.get_rid(), bytes.to_float32_array())
	batch.visible_instance_count = count
