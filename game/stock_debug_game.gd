extends "res://review/stress_game.gd"

const StressAura = preload("res://review/stress_aura.gd")

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
