extends "res://scripts/weapons/menhera.gd"

var full_cast := false
var full_cast_radius := 0.0
var full_cast_damage := 0.0

func radius() -> float:
	return full_cast_radius if full_cast else super.radius()

func dmg(base: float) -> float:
	return maxf(full_cast_damage, super.dmg(base)) if full_cast else super.dmg(base)

# One diagnostic use of the original weapon, with explicit test range and
# damage. The normal pulse timer is restored after the cast.
func cast_full_field(reach: float, minimum_damage: float) -> void:
	var saved_timer: float = tick_t
	full_cast_radius = reach
	full_cast_damage = minimum_damage
	full_cast = true
	tick_t = 0.0
	tick(0.0)
	tick_t = saved_timer
	full_cast = false
	game.fx.ring(player.global_position, 2.0, minf(reach, 650.0), Color(1.0, 0.48, 0.75), 0.55, 3.0)
