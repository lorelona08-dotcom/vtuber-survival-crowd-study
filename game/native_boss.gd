extends "res://scripts/game/enemy.gd"

# The upstream state machine runs unchanged. Synchronous shots, summons and
# zones can thus be attributed to their actual owner when many bosses act.
func _physics_process(delta: float) -> void:
	var observer = game.get_meta("main")
	observer.begin_native_pattern(self)
	super._physics_process(delta)
	observer.end_native_pattern(self)
