extends "res://review/stress_aura.gd"

# Keep the original weapon as the authority for animation, radius, pulse
# timing, damage and slow. The game provides one batched target group only
# during this specific weapon's synchronous area query.
func tick(delta: float) -> void:
	game.begin_crowd_aura(self)
	super.tick(delta)
	game.end_crowd_aura()
