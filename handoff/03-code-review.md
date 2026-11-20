# 코드별 병목과 개선 근거

**원작 적용을 먼저 검토할 곳은 `res://scripts/game/fx.gd`의 `_draw`입니다.** 이미 결정된 불꽃을 화면에 제출하는 방식만 바꾸면, 탄이 언제 벽에 닿는지부터 다음 웨이브가 언제 열리는지까지 기존 코드에 맡길 수 있습니다. 아래의 전체 성능 수치는 더 넓은 범위를 바꾼 독립 실험의 결과입니다.

원작 수정 제안은 별도 표시 모듈과 기존 그리기 함수에 한정합니다. 여기 나오는 적·투사체·무기·진행·저장 함수는 병목과 지켜야 할 동작을 확인하기 위한 읽기 전용 참조입니다.

아래 `res://`로 시작하는 경로는 원작자 Godot 프로젝트의 리소스 경로입니다. 공개 배포본은 스크립트를 `index.pck`에 담고 있어 함수 이름을 함께 적었습니다. 링크는 실험 코드의 측정 커밋 `44ce26c`에 고정했습니다. 실험판은 원작 커밋 `1ca4d9f`의 웹 엔진·데이터를 읽어 브라우저 메모리에 별도 장면을 추가합니다. [원작 배포](https://github.com/vtuber-survival/vtuber-survival.github.io/tree/1ca4d9f926535de42690583d28cb931c10e718b8) · [장면을 추가하는 코드](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/pack.js#L76) · [웹 실행 진입점](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/app.js#L566)

## 어떤 변경에서 얼마나 줄었나

| GitHub Pages에서 비교한 조건 | 원본 처리 | 개선 처리 | 수치가 설명하는 범위 |
| --- | ---: | ---: | --- |
| 몹 10만·보스 10종·적탄 3만, 같은 첫 12초 | 14.2 FPS | 64.7 FPS | 실험용 직선탄이 벽에 맞을 때의 불꽃 처리 경로만 교체. 프레임 시간 P95는 95.8 → 20.9ms |
| 몹 10만·보스 10종·적탄 1만, 이동 | 0.3 FPS | 79.1 FPS | 군중 이동·피격·보상·탄 처리·그리기를 함께 바꾼 전체 비교. 원본은 44.45초에 14프레임, 개선판은 40.02초에 3,164프레임 |

Chrome 158, Ryzen 7 9800X3D, RTX 5080, 화면 1280×720에서 측정했습니다. P95는 프레임 100개 중 95개가 그 시간 이내였다는 뜻입니다. 개선판에서도 1만 발 이동 시험의 최장 화면 프레임은 45.9ms, 새 군중 그림 사이의 최장 간격은 89.4ms였습니다. 원작에 그리기만 옮긴 뒤 얻을 속도는 아직 측정할 대상입니다. [13개 공개 플레이 측정](https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/results/mixed-r7.json) · [프레임별 원자료와 그림 대조 결과](https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/results/mixed-r7-runs.zip)

## 벽 충돌 불꽃

원작 `res://scripts/game/projectile.gd`의 `_physics_process`가 벽 충돌을 판정한 뒤 `fx.sparks(..., 3, ...)`를 호출합니다. `res://scripts/game/fx.gd`의 `sparks`는 입자마다 위치·속도·수명이 담긴 `Dictionary`를 만듭니다. `_process`는 살아 있는 입자를 갱신하고, `_draw`는 불꽃 하나에 선 1개와 사각형 2개를 그립니다. 한꺼번에 1,000발이 벽에 닿으면 불꽃 3,000개가 생겨 모두 살아 있는 프레임마다 그리기 명령이 9,000개에 이릅니다.

실험판은 충돌당 불꽃 3개와 원작 난수 호출 순서를 유지하면서 입자를 배열로 보관·갱신하고, 꼬리·몸통·중심을 한 인스턴스 메시로 제출합니다. 260회 충돌·780개 불꽃을 고정해 대조한 결과, 두 화면의 불꽃 픽셀 위치와 다음 Godot 난수 값이 같았습니다. 640×360 화면에서 146픽셀의 색이 달랐고 채널당 최대 차이는 1/255였습니다. 이 경로는 실험용 직선탄의 벽 충돌에 사용합니다. [불꽃 모양과 셰이더](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/wall_sparks.gd#L48) · [원작 순서의 난수 처리](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/wall_sparks.gd#L67) · [입자 갱신](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/wall_sparks.js#L81)

**원작 적용 후보.** `fx.gd`에서 기존 `sparks`와 `_process`가 만든 상태를 읽고 `_draw`의 반복 제출부터 줄입니다. 불꽃과 다른 효과가 섞이는 위치에서 묶음을 나누면 서로 가리는 순서를 유지할 수 있습니다. 실험판의 `take_impacts`는 자체 난수를 소비하고 전용 탄 풀에서 접촉 좌표를 가져옵니다. 기존 난수 호출 뒤에 이 함수를 추가하면 이후 전투 난수까지 달라질 수 있습니다.

## 군중의 이동과 그리기

원작 `res://scripts/game/game.gd`의 `spawn_enemy`가 적 객체를 만들고, `res://scripts/game/enemy.gd`의 `_ready`가 몸통과 그림자를 붙입니다. 각 적의 `_physics_process`가 움직임을 처리합니다. 원작의 `game.gd::_rebuild_grid`와 `enemies_in_radius`에는 이미 공간 격자가 있습니다. 강제 10만 전투에서 부담이 큰 부분은 개체별 호출, 매 틱의 격자 갱신, 화면에 겹치는 스프라이트입니다. 실제 전체 Godot 노드 수는 원본 처리에서 약 52만~56만, 개선판에서 약 1,200~2,000개였습니다. 개별 항목의 FPS 기여도는 이 전체 비교로 분리할 수 없습니다.

실험판은 15종의 위치·HP·상태를 개체별 배열에 두고 한 물리 틱에서 순회합니다. 나머지 특수 9종, 정예 속성, 보스는 원래 스크립트를 실행합니다. 그림은 별도 워커가 도트의 불투명 영역과 앞뒤 순서를 계산하고, Godot이 원본 그림으로 묶어 그립니다. 고정 10만 배치에서 몸통 제출은 100,000 → 25,877개, 그림자는 100,000 → 701개로 줄었고 화면의 RGB 픽셀 차이는 0개였습니다. [이동·접촉 계산](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/swarm.js#L604) · [가림과 그리기 순서](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/swarm.js#L880) · [워커에 보내는 코드](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/render_pipeline.js#L110) · [Godot 그리기](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/crowd_renderer.gd#L137)

**원작 적용 후보.** 원작 적 객체가 확정한 위치·애니메이션 프레임·색·방향을 읽어 그림자나 몸통 제출만 묶습니다. 보스·플레이어와의 앞뒤 순서, 반투명 도트, 피격 섬광, 카메라 배율이 보존되는 범위에서 사용합니다. 실험판의 15종 이동은 248틱 대조에서 최대 0.000020픽셀 차이를 보였습니다. `swarm.js`의 이동·접촉·피해·자체 난수는 실험용 전투 재구현입니다. 원작에서는 각 적 객체가 이 계산을 담당합니다. [원작 객체의 그림자 변환을 읽는 예](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/normal_game.gd#L42)

## 탄막의 충돌과 그리기

원작 `res://scripts/game/game.gd`의 `spawn_bullet`과 `res://scripts/game/projectile.gd`의 `_physics_process`가 탄별 수명·속도·벽·피격·보스 콜백을 처리합니다. 빽빽한 탄막에서는 매 틱의 객체 호출과 같은 도트 위에 겹친 그림 제출이 모두 늘어납니다.

실험용 추가 직선탄은 연속 배열에서 각 탄을 추적합니다. 같은 피해·둔화를 주는 직선탄 3만 발이 같은 틱에 명중한 대조 시험에서는 3만 건의 명중·소멸을 기록하고, 플레이어의 공통 피격 쿨다운 처리에 보내는 데이터가 600,000 → 20바이트로 줄었습니다. 원작 보스 고유 탄에는 발사자별 콜백이 있어 원래 투사체가 처리합니다. [개별 탄 물리](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/straight_shots.js#L207) · [엔진에 전달하는 접촉](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/hostile_shot_batch.gd#L70) · [3만 동시 명중 시험](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/qa/shot_impacts.cjs#L6)

**원작 적용 후보.** 전투 판정을 마친 뒤 같은 모양의 적탄이 같은 도트에 정확히 포개지면 그리기 순서상 마지막 한 장만 제출하는 방법입니다. 원본 이미지의 알파가 0 또는 255이고, 게임이 사용하는 표시 크기와 픽셀 정렬을 확인한 경우에만 씁니다. 해당 적탄은 HD 이미지가 22×18이고 실제 표시 크기는 11×9입니다. 카메라 5곳에서 전체 그리기와 비교해 픽셀 차이가 0개였습니다. 원작의 탄 생성·충돌·종료·명중 콜백은 그대로 호출하고, 부분 투명·다른 재질·회전·순서를 보장할 수 없는 경우는 원래 표시 경로를 사용합니다. [표시 크기와 알파 확인](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/hostile_shot_batch.gd#L17) · [마지막 그림을 남기는 코드](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/straight_shots.js#L302)

## 광역 처치와 보상

원작 `res://scripts/weapons/menhera.gd`의 `tick`은 범위 안 적마다 `game.hit`을 호출합니다. `res://scripts/game/game.gd`의 `on_enemy_died`는 적을 목록에서 지우고, 개별 드롭과 무기의 `on_kill`·`notify_kill_near`를 처리합니다. 아주 많은 적이 한 틱에 죽으면 제거·드롭 생성·콜백이 같은 시점에 몰립니다.

실험판은 `resolve_aura`에서 군중의 HP를 한 번에 순회해 개별 사망을 집계합니다. 경험치와 코인은 위치별로 합쳐 후속 틱에 아이템으로 만듭니다. 혼합 전멸 시험에서 처음 100,000마리의 실제 사망 100,000, 자연 이탈 0, 발생 경험치 160,778을 기록했습니다. 이 실험의 '발생 경험치'는 드롭 가치입니다. 아이템 위치·개수, 실제 획득 시점, 레벨업 시점과 무기별 콜백 순서는 원작 플레이에 영향을 줍니다. 광역 판정·치명타·드롭은 원작 함수에 맡기고, 합산·지연 생성은 실험에서만 사용합니다. [광역 경로](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/optimized_game.gd#L110) · [드롭 지연 처리](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/optimized_game.gd#L195) · [위치별 아이템 합산](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/optimized_game.gd#L219) · [초기 무리의 실제 사망 집계](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/finish_wave.gd#L42)

## 시험 장면과 원작 적용 검증

| 실험 파일 | 검토할 때 구분할 내용 |
| --- | --- |
| `review_scene.gd`, `mixed_roster.gd`, `stress_aura.gd`, `finish_wave.gd` | 강제 소환·탄 하한 보충·체력 회복·레벨업 자동 선택, 반경 768·최소 피해 64의 광역기, 반복 전멸은 측정용입니다. [디버그 시작](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/review_scene.gd#L78) · [강제 광역기](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/stress_aura.gd#L15) |
| `normal_scene.gd`, `normal_game.gd`, `first_use.gd` | 일반 웨이브 시험도 4분 50초·레벨 8에서 시작합니다. 보스 그림·소리를 로딩 중 미리 준비하는 함수와 일부 그림자를 묶는 부분은 따로 참고할 수 있습니다. `nearest_enemy` 재정의는 실험용 표적 선택 로직입니다. 원작의 표적 선정은 기존 함수에 맡깁니다. [시작 조건](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/normal_scene.gd#L16) · [리소스 준비](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/first_use.gd#L5) · [표적 선택 경계](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/game/normal_game.gd#L58) |

원작에 표시 변경을 시험할 때는 같은 시드와 틱별 입력을 재생해 소환 순서·HP·명중·보스 패턴·사망·개별 드롭과 획득·레벨업·다음 난수를 대조합니다. 원작 이벤트 순서와 게임 시계가 일치하는 상태에서, 실제 웹의 일반 웨이브로 프레임 시간 P95·최장·그림 갱신 간격을 비교합니다.

독립 실험을 직접 재현하려면 두 링크에서 모두 **3만 유지**와 **동시 패턴 발동**을 사용하세요. 자동 측정은 실험 저장소에서 아래 두 명령으로 같은 시드와 12초의 이동 입력을 재생합니다. [원작식 벽 불꽃](https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/?v=mixed-r7&preset=mixed&mode=optimized&count=100000&seed=7&wallfx=native) · [일괄 처리한 벽 불꽃](https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/?v=mixed-r7&preset=mixed&mode=optimized&count=100000&seed=7&wallfx=batch) · [측정 코드](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/44ce26c00a6e4e02579aff71969a76d64b533c1c/qa/mixed.py)

```console
python qa/mixed.py --floor 30000 --seconds 12 --wall-fx native --output qa-output/wall-native.json
python qa/mixed.py --floor 30000 --seconds 12 --wall-fx batch --output qa-output/wall-batch.json
```
