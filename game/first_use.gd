extends RefCounted

# Register sounds while the loading cover is still visible. A loaded Ogg
# resource can otherwise pay the Web audio sample conversion cost on play().
static func warm(boss_kinds: Array) -> void:
	for key in ["bgm_boss", "boss", "dash", "hurt", "hit", "kill", "gem",
			"coin", "levelup", "death", "bossdown", "victory", "bgm_menu"]:
		var stream: AudioStream = Sfx.streams.get(key)
		if stream != null and not AudioServer.is_stream_registered_as_sample(stream):
			AudioServer.register_stream_as_sample(stream)
	for kind in boss_kinds:
		for suffix in ["_rig.png", "_hd.png", ".png"]:
			var path := "res://assets/bosses/%s%s" % [kind, suffix]
			if ResourceLoader.exists(path):
				Data.tex(path)
				break
