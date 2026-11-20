extends "res://scripts/game/game.gd"

const CrowdRenderer = preload("res://review/crowd_renderer.gd")
const CrowdTarget = preload("res://review/crowd_target.gd")

var crowd
var renderer
var target_handles: Dictionary = {}
var review_enemy: Dictionary

func _ready() -> void:
	super._ready()
	review_enemy = Data.ENEMIES["jjorang"]

func configure_crowd(capacity: int, scenario_seed: int) -> void:
	crowd = JavaScriptBridge.get_interface("VSCrowd")
	crowd.reset(capacity, scenario_seed)
	renderer = CrowdRenderer.new()
	add_child(renderer)
	renderer.setup(self, capacity)

func add_crowd_enemy(pos: Vector2, speed: float, phase: float) -> void:
	crowd.spawn(pos.x, pos.y, float(review_enemy.hp), speed, phase)

func advance_crowd(delta: float) -> void:
	var pos: Vector2 = player.global_position
	var speed_multiplier: float = enemy_speed_mult * enemy_slow * time_slow
	var contact_id := int(crowd.step(delta, pos.x, pos.y, speed_multiplier, player.hit_r()))
	# Ordinary contact applies the player's original shared hurt cooldown. Extra
	# contacts in a cooldown window produce no further damage or knockback.
	if contact_id >= 0 and player.alive and player.hurt_cd <= 0.0 and player.invuln <= 0.0:
		var row := _unpack(crowd.snapshot(contact_id))
		if row.size() == 4:
			player.contact(float(review_enemy.dmg), _target(row, 0))

func enemies_in_radius(pos: Vector2, radius: float) -> Array:
	var nearby: Array = super.enemies_in_radius(pos, radius) if not enemies.is_empty() else []
	if crowd != null:
		var rows := _unpack(crowd.query(pos.x, pos.y, radius))
		for offset in range(0, rows.size(), 4):
			nearby.append(_target(rows, offset))
	return nearby

func _target(rows: PackedFloat32Array, offset: int):
	var id := int(rows[offset])
	var target = target_handles.get(id)
	if target == null:
		target = CrowdTarget.new()
		target.game = self
		target.crowd_id = id
		target.radius = review_enemy.r
		target.xp = review_enemy.xp
		target.max_hp = review_enemy.hp
		target_handles[id] = target
	target.global_position = Vector2(rows[offset + 1], rows[offset + 2])
	target.hp = rows[offset + 3]
	return target

func forget_crowd_target(id: int) -> void:
	target_handles.erase(id)

func _unpack(buffer) -> PackedFloat32Array:
	return JavaScriptBridge.js_buffer_to_packed_byte_array(buffer).to_float32_array()
