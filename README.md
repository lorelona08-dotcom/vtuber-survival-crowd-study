# V-tuber 서바이벌 혼합 전투 성능 실험

**[10만 마리·보스 10종·적탄 1만 발로 바로 플레이](https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/?v=mixed-r6&preset=mixed&mode=optimized&count=100000&seed=7)** · [일반 웨이브와 5분 보스](https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/?v=mixed-r6&scenario=normal&mode=optimized&seed=7) · [구현 메모](AGENTS.md)

원작 Godot 웹 엔진·맵·조하구·무기로 플레이하는 비공식 디버그 빌드입니다. 공원에서 WASD·방향키·터치로 이동합니다. 원작 배포 파일은 브라우저에서 고정 커밋의 SHA-256을 확인하고 읽습니다. 원작 제작진과 리소스의 출처는 원작 프로젝트입니다. [원작 게임](https://vtuber-survival.github.io/) · [기준 배포](https://github.com/vtuber-survival/vtuber-survival.github.io/tree/1ca4d9f926535de42690583d28cb931c10e718b8)

## 직접 확인하기

| 조작 | 화면에서 확인하는 값 |
| --- | --- |
| 전투 시작 · 전 종류 배치 | `Data.ENEMIES` 24종의 실제 생존·누적 생성 수. 15종을 번갈아 대량 생성하고 나머지 9종은 원래 규칙에 맞춰 무리와 벽을 배치합니다. 원작 정예 속성 5종과 별도 소환물인 하트도 추적합니다. 보스가 소환한 몹이 합류하면 일반 적 수가 잠시 10만을 넘습니다. |
| 10종 동시 소환 · 동시 패턴 발동 | 도배봇·버퍼링·대분탕·글리치·끝없는 계단·눈보라 정령·마카롱 포탑·책벌레·박쥐 떼·연체 반납함의 살아 있는 원작 객체와 각각의 AI 상태·발사·장판·소환. |
| 1만 유지 · 3만 유지 | 물리 틱에서 만료·벽 충돌·명중을 처리한 뒤 부족한 적탄을 보충합니다. 현재 보스/원작 AI 탄과 실험용 직선탄, 실제 유지 하한·확인한 틱 수를 볼 수 있습니다. 플레이어 탄은 별도입니다. |
| 광역기로 전원 공격 | 조하구 광역기 1회로 HP가 줄고 실제 처치·XP·생존 종과 공격 프레임 시간이 표시됩니다. 잠복, 벽의 피해 상한, 말아 막기, 높은 체력은 원작 판정을 따릅니다. [단일 구성에서 10만 일격 전멸 재현](https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/?v=mixed-r6&preset=single&mode=optimized&count=100000&seed=7) |
| 현재 무리 끝까지 공격 | 0.55 게임초마다 같은 광역기를 발동합니다. 시작 시 살아 있던 개체의 실제 사망, 자연 이탈, 남은 적, XP와 이후 소환물은 각각 표시됩니다. 종료 조건은 초기 무리 해소 또는 45 게임초입니다. |
| 최대 부하 재현 · 광역기 2회 반복 | 10만 혼합·보스 10종 패턴·적탄 하한 3만을 만들고 처치·재생성 시점의 프레임을 비교할 수 있습니다. 적 삭제는 처치 보상을 발생시키지 않습니다. |

**원본 처리**에서는 같은 스트레스 조건을 원작의 개별 적·개별 투사체로 실행합니다. **일반 웨이브**는 4분 50초 공원에서 원래 웨이브·보스 일정과 수동 레벨업으로 플레이합니다. [원본 처리 비교](https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/?v=mixed-r6&preset=mixed&mode=original&count=10000&seed=7)

## 검증과 재현

프레임은 실제 전투 중 브라우저 rAF에서 기록하고, 군중 그림은 워커가 계산한 새 결과가 게임에 반영될 때마다 따로 측정합니다. 조작, 실제 생존·피격·XP, 게임 시간의 진행률은 같은 기록에 포함됩니다. 데스크톱과 모바일은 브라우저와 기기별로 성능이 달라집니다.

```console
python qa/mixed.py --seconds 40
python qa/mixed.py --floor 30000 --case cycles --cycles 3 --seconds 3
python qa/mixed.py --case finish
python qa/play.py --case normal --headed --seconds 30
```

브라우저는 기본적으로 공개 GitHub Pages에 접속합니다. Python Playwright와 Chrome이 필요합니다. 이전 단일 종류·보스 4종 빌드의 결과도 비교할 수 있습니다. [이전 실행 기록](results/summary.json) · [이전 버전 설명](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/f532c9ad3b45be9dc8f3c42a55029d6b7a912890/README.md)
