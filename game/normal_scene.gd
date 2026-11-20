extends "res://scripts/main.gd"

const NativeGame = preload("res://scripts/game/game.gd")
const NormalOptimizedGame = preload("res://review/normal_game.gd")
const ViewSettings = preload("res://scripts/ui/ui_util.gd")
const START_SECONDS := 290.0
var bridge
var game
var comparison_mode := "original"
var last_report_ms := 0
var ticks := 0
var active_seconds := 0.0
var game_ended := false
var boss_peak := 0

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_physics_priority = 1000002
	bridge = JavaScriptBridge.get_interface("VSReview")
	comparison_mode = str(bridge.mode)
	Save.data = Save.default_data()
	Save.data["low_gfx"] = false
	ViewSettings.apply_fit()
	ViewSettings.apply_gfx()
	seed(int(bridge.seed))
	game = NormalOptimizedGame.new() if comparison_mode == "optimized" else NativeGame.new()
	current_name = "game"
	current = game
	game.set_meta("main", self)
	game.setup({"char": "johagu", "map": "field", "auto": false})
	add_child(game)
	# A reproducible mid-run loadout, ten seconds before the original first boss.
	game.t = START_SECONDS
	while game.swarm_i < game.SWARM_TIMES.size() and game.SWARM_TIMES[game.swarm_i] < game.t:
		game.swarm_i += 1
	game.level = 8
	game.xp_need = Data.xp_to_next(game.level)
	game.player.weapons[0].level = 3
	game.give_weapon("vinyl").level = 3
	_report()

func _physics_process(delta: float) -> void:
	if not get_tree().paused and not game_ended:
		ticks += 1
		active_seconds += delta

func _process(_delta: float) -> void:
	var now := Time.get_ticks_msec()
	if now - last_report_ms >= 250 and not game_ended:
		last_report_ms = now
		_report()

func _report() -> void:
	var phase := "playing"
	if game_ended:
		phase = "ended"
	elif get_tree().paused:
		phase = "levelup" if game.levelup_ui.root.visible else "paused"
	var common := 0
	var visible_units := 0
	var bosses := 0
	var kinds := {}
	var view: Rect2 = game.view_rect()
	for enemy in game.enemies:
		if enemy.dead:
			continue
		if enemy.boss:
			bosses += 1
		else:
			common += 1
			if view.has_point(enemy.global_position):
				visible_units += 1
		kinds[enemy.kind] = true
	var hostile := 0
	for projectile in game.projectiles:
		if projectile.hostile:
			hostile += 1
	boss_peak = maxi(boss_peak, bosses)
	var boss = game.active_boss
	var total_damage := 0.0
	for value in game.dmg_stats.values():
		total_damage += float(value)
	bridge.sample(JSON.stringify({
		"scenario": "normal", "mode": comparison_mode, "phase": phase, "ready": ticks > 0 and phase == "playing",
		"alive": common, "visible": visible_units, "updated": common if ticks > 0 else 0,
		"target": 0, "spawned": common + game.kills, "kills": game.kills, "damage": total_damage,
		"hp": game.player.hp, "maxHp": game.player.max_hp, "xp": game.xp, "level": game.level,
		"x": game.player.global_position.x, "y": game.player.global_position.y,
		"simTime": active_seconds, "gameClock": game.t, "ticks": ticks,
		"projectiles": game.projectiles.size(), "hostileProjectiles": hostile,
		"playerProjectiles": game.projectiles.size() - hostile, "bosses": bosses,
		"bossKind": boss.kind if is_instance_valid(boss) else "", "bossState": boss.b_state if is_instance_valid(boss) else "",
		"bossPeak": boss_peak, "zones": game.zones.size(), "enemyKinds": kinds.keys(),
		"nodes": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"draws": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
		"engineFps": Engine.get_frames_per_second()
	}))

func goto(screen: String, params := {}) -> void:
	if not game_ended:
		game_ended = true
		_report()
	super.goto(screen, params)
