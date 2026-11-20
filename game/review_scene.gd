extends Node

const OriginalGame = preload("res://scripts/game/game.gd")
const OptimizedGame = preload("res://review/optimized_game.gd")
const ViewSettings = preload("res://scripts/ui/ui_util.gd")
const HALF_VIEW := Vector2(320, 180)
const SPAWN_RECT := Vector2(286, 148)
const TELEMETRY_INTERVAL := 0.25

var bridge
var game
var optimized := false
var mode := "original"
var target_count := 10000
var scenario_seed := 7
var placement := RandomNumberGenerator.new()
var enemy_kind: Dictionary
var phase := "spawning"
var spawned := 0
var ticks := 0
var elapsed := 0.0
var next_report := 0.0
var last_health := 0.0
var hits_taken := 0
var damage_taken := 0.0
var recoveries := 0
var last_updated := 0

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_physics_priority = 1000002
	bridge = JavaScriptBridge.get_interface("VSReview")
	mode = str(bridge.mode)
	target_count = clampi(int(bridge.count), 1, 12000)
	scenario_seed = int(bridge.seed)
	optimized = mode == "optimized"
	placement.seed = scenario_seed
	seed(scenario_seed)
	# Every visit starts with the same equipment and no account progress.
	Save.data = Save.default_data()
	Save.data["low_gfx"] = false
	ViewSettings.apply_fit()
	ViewSettings.apply_gfx()
	# A slow renderer cannot accumulate many expensive simulation steps in a
	# single browser callback. Both modes have the same cap and report game time.
	Engine.max_physics_steps_per_frame = 1
	game = OptimizedGame.new() if optimized else OriginalGame.new()
	game.set_meta("main", self)
	game.setup({"char": "johagu", "map": "field", "auto": false})
	add_child(game)
	game.mob_mult = 0.0
	game.boss_index = Data.BOSS_TIMES.size()
	game.final_spawned = true
	game.process_mode = Node.PROCESS_MODE_DISABLED
	enemy_kind = Data.ENEMIES["jjorang"]
	if optimized:
		game.configure_crowd(target_count, scenario_seed)
	last_health = game.player.hp
	_report()

func _process(_delta: float) -> void:
	if phase == "spawning":
		var deadline := Time.get_ticks_usec() + 4200
		while spawned < target_count:
			_spawn_one(true)
			if Time.get_ticks_usec() >= deadline:
				break
		if spawned == target_count:
			seed(scenario_seed)
			phase = "playing"
			game.process_mode = Node.PROCESS_MODE_PAUSABLE
			_report()
	var now := Time.get_ticks_msec() / 1000.0
	if now >= next_report:
		next_report = now + TELEMETRY_INTERVAL
		_report()

func _physics_process(delta: float) -> void:
	if phase != "playing" or get_tree().paused or game.finished:
		return
	if optimized:
		game.advance_crowd(delta)
	# Jjorang deaths from the aura happen before their movement phase. Count
	# survivors before adding replacements, which first move on the next tick.
	last_updated = int(game.crowd.updatedCount()) if optimized else game.enemies.size()
	ticks += 1
	elapsed += delta
	var hp: float = game.player.hp
	if hp < last_health:
		hits_taken += 1
		damage_taken += last_health - hp
	# Keep the continuous play comparison alive; the original damage, hit
	# cooldown, audio and hit feedback have already run before this assistance.
	if hp > 0.0 and hp <= game.player.max_hp * 0.25:
		game.player.heal(game.player.max_hp)
		recoveries += 1
	# Resolve level rewards through the real game API. Both sides retain the
	# starter's aura and gain XP and levels without modal pauses during timing.
	while game.pending_levelups > 0:
		game.pending_levelups -= 1
		if game.player.weapons[0].level < 5:
			game.apply_option({"type": "weapon_up", "id": "menhera"})
		else:
			game.apply_option({"type": "gold"})
	last_health = game.player.hp
	var missing := target_count - _population()
	for i in missing:
		_spawn_one(false)

func _spawn_one(initial: bool) -> void:
	var position_in_arena: Vector2
	if initial:
		position_in_arena = Vector2(
			placement.randf_range(-SPAWN_RECT.x, SPAWN_RECT.x),
			placement.randf_range(-SPAWN_RECT.y, SPAWN_RECT.y)
		)
		while position_in_arena.length_squared() < 46.0 * 46.0:
			position_in_arena = Vector2(
				placement.randf_range(-SPAWN_RECT.x, SPAWN_RECT.x),
				placement.randf_range(-SPAWN_RECT.y, SPAWN_RECT.y)
			)
	else:
		var angle := placement.randf() * TAU
		position_in_arena = game.player.global_position + Vector2.from_angle(angle) * SPAWN_RECT
	var speed: float = float(enemy_kind.speed) * placement.randf_range(0.92, 1.08)
	var animation_phase := placement.randf() * TAU
	if optimized:
		game.add_crowd_enemy(position_in_arena, speed, animation_phase)
	else:
		var enemy = game.spawn_enemy("jjorang", position_in_arena)
		enemy.speed = speed
		enemy.phase = animation_phase
	spawned += 1

func _population() -> int:
	return int(game.crowd.aliveCount()) if optimized else game.enemies.size()

func _report() -> void:
	var position_in_world: Vector2 = game.player.global_position
	var alive := _population()
	var visible_count := 0
	if optimized:
		visible_count = int(game.crowd.visibleCount(position_in_world.x, position_in_world.y, HALF_VIEW.x, HALF_VIEW.y))
	else:
		var viewport_rect := Rect2(position_in_world - HALF_VIEW, HALF_VIEW * 2.0)
		for enemy in game.enemies:
			if viewport_rect.has_point(enemy.global_position):
				visible_count += 1
	var data := {
		"mode": mode, "phase": "paused" if get_tree().paused else phase,
		"ready": phase == "playing" and ticks > 0 and not get_tree().paused,
		"target": target_count, "alive": alive, "visible": visible_count,
		"updated": last_updated, "spawned": spawned, "kills": game.kills,
		"damage": game.dmg_stats.get("menhera", 0.0), "hp": game.player.hp,
		"hitsTaken": hits_taken, "damageTaken": damage_taken, "recoveries": recoveries,
		"maxHp": game.player.max_hp, "xp": game.xp, "level": game.level,
		"weaponLevel": game.player.weapons[0].level,
		"x": position_in_world.x, "y": position_in_world.y, "simTime": elapsed, "ticks": ticks,
		"draws": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
		"engineFps": Engine.get_frames_per_second()
	}
	bridge.sample(JSON.stringify(data))

func goto(_screen: String, _params := {}) -> void:
	phase = "ended"
	game.process_mode = Node.PROCESS_MODE_DISABLED
	get_tree().paused = false
	_report()
