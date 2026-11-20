extends "res://scripts/game/game.gd"

const StressAura = preload("res://review/stress_aura.gd")
var count_full_cast := false
var full_hits := 0
var full_ordinary_kills := 0
var full_ordinary_damage := 0.0
var full_xp_created := 0.0

# The baseline uses upstream individual enemies, attack iteration, projectiles,
# deaths, achievements and pickup spawning. Only the selectable one-shot spell
# needs an override of the starter's range and damage.
func give_weapon(id: String):
	if id != "menhera":
		return super.give_weapon(id)
	Ach.dex_add("weapons", id)
	var weapon = StressAura.new()
	weapon.setup(self, player, id)
	ground.add_child(weapon)
	player.weapons.append(weapon)
	return weapon

func hit(target, amount: float, weapon = null, knock := Vector2.ZERO) -> bool:
	if count_full_cast and is_instance_valid(target) and not target.dead and target.targetable and target.kind == "jjorang" and not target.minion:
		full_hits += 1
		var hp_before: float = target.hp
		var killed := super.hit(target, amount, weapon, knock)
		full_ordinary_damage += hp_before - maxf(0.0, target.hp)
		if killed:
			full_ordinary_kills += 1
		return killed
	return super.hit(target, amount, weapon, knock)

func spawn_pickup(kind: String, pos: Vector2, value: float):
	if count_full_cast and kind == "gem":
		full_xp_created += value
	return super.spawn_pickup(kind, pos, value)
