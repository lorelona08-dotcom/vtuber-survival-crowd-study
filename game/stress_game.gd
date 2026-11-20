extends "res://scripts/game/game.gd"

const ObservedBoss = preload("res://review/native_boss.gd")
var count_full_cast := false
var full_hits := 0
var full_ordinary_kills := 0
var full_ordinary_damage := 0.0
var full_xp_created := 0.0
var full_native_hits_by_kind: Dictionary = {}
var full_native_deaths_by_kind: Dictionary = {}
var heart_contacts := 0
var finish_tracker
var finish_collect_native_xp := false

func flirt_source_pos(heart) -> Vector2:
	# The upstream charming-heart actor asks for its owner only on contact.
	heart_contacts += 1
	return super.flirt_source_pos(heart)

func spawn_enemy(kind: String, pos: Vector2, opts := {}):
	if not opts.get("boss", false):
		return super.spawn_enemy(kind, pos, opts)
	Ach.dex_add("bosses", kind)
	var actor = ObservedBoss.new()
	actor.setup(self, kind, opts)
	actor.global_position = pos
	world.add_child(actor)
	enemies.append(actor)
	return actor

func hit(target, amount: float, weapon = null, knock := Vector2.ZERO) -> bool:
	if count_full_cast and is_instance_valid(target) and not target.dead and target.targetable and Data.ENEMIES.has(target.kind):
		full_hits += 1
		var kind: String = target.kind
		full_native_hits_by_kind[kind] = int(full_native_hits_by_kind.get(kind, 0)) + 1
		var previous_hp: float = target.hp
		var killed := super.hit(target, amount, weapon, knock)
		full_ordinary_damage += previous_hp - maxf(0.0, target.hp)
		if killed:
			full_ordinary_kills += 1
			full_native_deaths_by_kind[kind] = int(full_native_deaths_by_kind.get(kind, 0)) + 1
		return killed
	return super.hit(target, amount, weapon, knock)

func on_enemy_died(actor) -> void:
	var prior := finish_collect_native_xp
	finish_collect_native_xp = finish_tracker != null and finish_tracker.native_combat_death(actor)
	super.on_enemy_died(actor)
	finish_collect_native_xp = prior

func spawn_pickup(kind: String, pos: Vector2, value: float):
	if count_full_cast and kind == "gem":
		full_xp_created += value
	if finish_collect_native_xp and kind == "gem":
		finish_tracker.native_xp += value
	return super.spawn_pickup(kind, pos, value)
