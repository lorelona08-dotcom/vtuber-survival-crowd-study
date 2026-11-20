extends "res://scripts/game/game.gd"

const CrowdRenderer = preload("res://review/crowd_renderer.gd")
const CrowdTarget = preload("res://review/crowd_target.gd")
const CrowdAura = preload("res://review/crowd_aura.gd")

var crowd
var renderer
var target_handles: Dictionary = {}
var review_enemy: Dictionary
var aura_window
var drop_cells: Dictionary = {}
var pulses := 0
var pulse_targets := 0
var xp_dropped := 0
var coin_dropped := 0
var queued_xp := 0.0
var queued_gold := 0.0
var pending_drops: Dictionary = {}
var nearby_drops: Array = []
var distant_drops: Array = []

# The original aura sends damage and slowing as two successive callbacks.
# This command object records both values, then applies them to every
# individual inside the exact attack radius in one bridge call.
class AreaCommand extends RefCounted:
	var owner_game
	var source
	var global_position: Vector2
	var radius := 0.0
	var amount: float

	func apply_slow(multiplier: float, duration: float) -> void:
		owner_game.resolve_aura(global_position, source, amount, multiplier, duration)

func give_weapon(id: String):
	if id != "menhera":
		return super.give_weapon(id)
	Ach.dex_add("weapons", id)
	var weapon = CrowdAura.new()
	weapon.setup(self, player, id)
	ground.add_child(weapon)
	player.weapons.append(weapon)
	return weapon

func _ready() -> void:
	super._ready()
	review_enemy = Data.ENEMIES["jjorang"]

func configure_crowd(capacity: int) -> void:
	crowd = JavaScriptBridge.get_interface("VSCrowd")
	renderer = CrowdRenderer.new()
	add_child(renderer)
	renderer.setup(self, capacity)

func begin_crowd_aura(weapon) -> void:
	aura_window = weapon

func end_crowd_aura() -> void:
	aura_window = null

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
	_flush_drops()

func enemies_in_radius(pos: Vector2, radius: float) -> Array:
	var nearby: Array = super.enemies_in_radius(pos, radius) if not enemies.is_empty() else []
	if crowd != null:
		if aura_window != null:
			if int(crowd.aliveCount()) > 0:
				var command = AreaCommand.new()
				command.owner_game = self
				command.source = aura_window
				command.global_position = pos
				nearby.append(command)
			aura_window = null
			return nearby
		var rows := _unpack(crowd.query(pos.x, pos.y, radius))
		for offset in range(0, rows.size(), 4):
			nearby.append(_target(rows, offset))
	return nearby

func hit(target, amount: float, weapon = null, knock := Vector2.ZERO) -> bool:
	if target is AreaCommand:
		target.amount = amount
		return false
	return super.hit(target, amount, weapon, knock)

func resolve_aura(origin: Vector2, weapon, amount: float, slow_factor: float, duration: float) -> void:
	# This scenario has a single non-awakened starter and no crit equipment.
	# Bosses and other native scene enemies have already used the original
	# per-enemy hit path. The packed path covers normal Jjorang only.
	var result: PackedFloat32Array
	if weapon.full_cast:
		result = _unpack(crowd.pulseAll(
			origin.x, origin.y, amount * enemy_vuln, slow_factor, duration, player.crit,
			player.crit_mult, _drop_chance("cheese"), _drop_chance("ticket"), weapon.radius()
		))
	else:
		result = _unpack(crowd.pulse(
			origin.x, origin.y, weapon.radius() + float(review_enemy.r), amount * enemy_vuln,
			slow_factor, duration, player.crit, player.crit_mult,
			_drop_chance("cheese"), _drop_chance("ticket")
		))
	var n_hit := int(result[0])
	if n_hit == 0:
		return
	pulses += 1
	pulse_targets += n_hit
	var killed := int(result[1])
	dmg_stats[weapon.id] = dmg_stats.get(weapon.id, 0.0) + result[2]
	raw_stats[weapon.id] = raw_stats.get(weapon.id, 0.0) + result[3]
	var crits := int(result[4])
	if crits > 0:
		Ach.stat("crits", crits)
	if killed > 0:
		var before := kills
		kills += killed
		Ach.stat("kills", killed)
		if before < 1000 and kills >= 1000:
			Ach.unlock("k1000_" + char_id)
		target_handles.clear()
		Sfx.play("kill", -16.0)
	_emit_drop("cheese", result[5], result[6])
	_emit_drop("ticket", result[7], result[8])
	Sfx.play("hit", -14.0)
	var index := 11
	for i in int(result[9]):
		var point := Vector2(result[index], result[index + 1])
		var critical := result[index + 3] > 0
		var color := Color(1.0, 0.75, 0.2) if critical else Color.WHITE
		fx.number(point + Vector2(0, -8), result[index + 2], color, critical)
		index += 4
	for i in int(result[10]):
		var point := Vector2(result[index], result[index + 1])
		var gems := int(result[index + 2])
		var coins := int(result[index + 3])
		if gems > 0:
			var xp_value: float = gems * float(review_enemy.xp)
			xp_dropped += int(xp_value)
			_queue_drop("gem", point, xp_value)
		if coins > 0:
			coin_dropped += 5 * coins
			_queue_drop("coin", point + Vector2(4, 2), 5.0 * coins)
		index += 4

func _drop_chance(id: String) -> float:
	var spec: Dictionary = Data.DROPS[id]
	return float(spec.chance) if t >= float(spec.after) and t - float(drop_last.get(id, -999.0)) >= float(spec.gap) else 0.0

func _emit_drop(id: String, x: float, y: float) -> void:
	if is_finite(x) and is_finite(y):
		drop_last[id] = t
		spawn_pickup(id, Vector2(x, y), 1.0)

func _queue_drop(kind: String, point: Vector2, value: float) -> void:
	var cell := Vector3i(floori(point.x / 16.0), floori(point.y / 16.0), 0 if kind == "gem" else 1)
	if kind == "gem":
		queued_xp += value
	else:
		queued_gold += value
	if pending_drops.has(cell):
		pending_drops[cell].value += value
		return
	pending_drops[cell] = {"kind": kind, "point": point, "value": value}
	if point.distance_squared_to(player.global_position) < 96.0 * 96.0:
		nearby_drops.append(cell)
	else:
		distant_drops.append(cell)

func _flush_drops() -> void:
	if pending_drops.is_empty():
		return
	var deadline := Time.get_ticks_usec() + 650
	for i in 32:
		var queue := nearby_drops if not nearby_drops.is_empty() else distant_drops
		if queue.is_empty():
			return
		var cell: Vector3i = queue.pop_back()
		var drop: Dictionary = pending_drops[cell]
		pending_drops.erase(cell)
		if drop.kind == "gem":
			queued_xp -= drop.value
		else:
			queued_gold -= drop.value
		_stack_drop(cell, drop.kind, drop.point, drop.value)
		if Time.get_ticks_usec() >= deadline:
			return

func _stack_drop(cell: Vector3i, kind: String, point: Vector2, value: float) -> void:
	var old = drop_cells.get(cell)
	if is_instance_valid(old) and not old.flying:
		old.value += value
		old.refresh_sprite()
	else:
		var item = super.spawn_pickup(kind, point, value)
		if not is_instance_valid(old) or old != item:
			drop_cells[cell] = item
			var forget := _forget_drop.bind(cell, item)
			if not item.tree_exiting.is_connected(forget):
				item.tree_exiting.connect(forget, CONNECT_ONE_SHOT)

func _forget_drop(cell: Vector3i, item) -> void:
	if drop_cells.get(cell) == item:
		drop_cells.erase(cell)

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
