extends RefCounted

# A weapon sees a target only while it needs one. Persistent motion, health
# and owner-independent lifetime live in the packed crowd, outside the scene tree.
var game
var crowd_id: int
var global_position: Vector2
var hp: float
var max_hp: float
var radius: float
var xp: float
var kind := "jjorang"
var move := "hop"
var targetable := true
var dead := false
var boss := false
var elite := false
var scale_f := 1.0
var xp_half := false
var last_weapon

func configure_species(key: String) -> void:
	var info: Dictionary = Data.ENEMIES[key]
	kind = key
	move = info.move
	max_hp = info.hp
	xp = info.xp
	radius = info.r
	if bool(game.crowd.isMinionSpecies(key)):
		max_hp *= 0.4
		radius *= 0.8
		scale_f = 0.75
		xp = 1

func damage(amount: float, weapon = null, knock_vec := Vector2.ZERO) -> bool:
	if dead:
		return false
	var remaining: float = game.crowd.hurt(crowd_id, amount * game.enemy_vuln, knock_vec.x, knock_vec.y)
	if remaining < 0.0:
		return false
	hp = remaining
	last_weapon = weapon
	if hp > 0.0:
		return false
	dead = true
	targetable = false
	game.forget_crowd_target(crowd_id)
	game.on_enemy_died(self)
	return true

func apply_slow(multiplier: float, duration: float) -> void:
	if not dead:
		game.crowd.slow(crowd_id, multiplier, duration)
