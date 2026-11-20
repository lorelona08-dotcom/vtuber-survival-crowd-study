extends "res://scripts/game/game.gd"

var common_shadows: MultiMesh

func _ready() -> void:
	preload("res://review/first_use.gd").warm(Data.MAPS[map_id].bosses)
	super._ready()
	var texture: Texture2D = Data.tex("res://assets/fx/shadow.png")
	var quad := QuadMesh.new()
	quad.size = texture.get_size()
	common_shadows = MultiMesh.new()
	common_shadows.transform_format = MultiMesh.TRANSFORM_2D
	common_shadows.use_colors = true
	common_shadows.mesh = quad
	common_shadows.instance_count = 512
	common_shadows.visible_instance_count = 0
	var layer := MultiMeshInstance2D.new()
	layer.multimesh = common_shadows
	layer.texture = texture
	layer.z_index = -1
	var shader := Shader.new()
	shader.code = "shader_type canvas_item; void vertex() { UV.y = 1.0 - UV.y; }"
	var material := ShaderMaterial.new()
	material.shader = shader
	layer.material = material
	add_child(layer)

func spawn_enemy(kind: String, pos: Vector2, opts := {}):
	var enemy = super.spawn_enemy(kind, pos, opts)
	if not enemy.boss and not enemy.elite and enemy.move in ["hop", "run", "tank"] and enemy.shadow.visible:
		enemy.set_meta("review_common_shadow", true)
		enemy.shadow.visible = false
	return enemy

func on_enemy_died(enemy) -> void:
	if enemy.has_meta("review_common_shadow"):
		enemy.shadow.visible = true
	super.on_enemy_died(enemy)

var last_shadow_tick := -1

func _process(_delta: float) -> void:
	var tick := Engine.get_physics_frames()
	if common_shadows == null or tick == last_shadow_tick:
		return
	last_shadow_tick = tick
	if enemies.size() > common_shadows.instance_count:
		common_shadows.instance_count = maxi(enemies.size(), common_shadows.instance_count * 2)
	var index := 0
	for enemy in enemies:
		if enemy.has_meta("review_common_shadow") and not enemy.dead:
			common_shadows.set_instance_transform_2d(index, enemy.shadow.global_transform)
			common_shadows.set_instance_color(index, enemy.shadow.modulate * enemy.modulate)
			index += 1
	common_shadows.visible_instance_count = index

# The upstream randomized query picks one of the four closest candidates.
func nearest_enemy(pos: Vector2, maxr: float, randomize := false):
	var nearest = null
	var distance_limit := maxr * maxr
	var candidates := 0
	var top: Array = []
	var distances: Array[float] = []
	for enemy in enemies_in_radius(pos, maxr):
		if enemy.move == "wall":
			continue
		candidates += 1
		var distance: float = enemy.global_position.distance_squared_to(pos)
		if distance < distance_limit:
			nearest = enemy
			distance_limit = distance
		if randomize and (top.size() < 4 or distance < distances.back()):
			var at := top.size()
			while at > 0 and distance < distances[at - 1]:
				at -= 1
			top.insert(at, enemy)
			distances.insert(at, distance)
			if top.size() > 4:
				top.pop_back()
				distances.pop_back()
	return top[randi() % 4] if randomize and candidates > 3 else nearest
