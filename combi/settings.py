"""분석 설정값 (노트북 설정 칸과 같은 뜻 · 같은 기본값)"""
from dataclasses import asdict, dataclass, fields


@dataclass(frozen=True)
class Settings:
    min_n: int = 4                       # 조합에 필요한 최소 웨이퍼 수
    max_depth: int | None = 3            # 조합에 묶을 최대 Order 수 (None이면 제한 없이 새 조합이 나오지 않을 때까지)
    part_id: str | None = None           # 한 제품만 볼 때
    line_id: str | None = None           # 한 라인만 볼 때
    step_suffix: str | None = r'_(\d+)$'  # step_seq 끝의 Order 번호 규칙 (None이면 step_seq를 STEP, step_ord를 Order로)
    higher_is_worse: bool = True         # Value가 클수록 나쁘면 True (수율처럼 클수록 좋으면 False)
    y_transform: str | None = 'auto'     # 치우친 Value: 'auto' 치우치면 순위로 · 'rank' · 'log' · None 그대로
    part_adjust: bool | str = True       # part마다 Value · bad를 맞춤: True · 'auto' 차이가 뚜렷할 때만 · False
    part_min: int = 20                   # 웨이퍼가 이보다 적은 part는 하나로 묶어 맞춤
    rework: str = 'last'                 # 같은 웨이퍼 · STEP · Order 이력이 여러 줄이면 'last' 마지막 · 'first' 처음
    same_wafers: float | None = 0.9      # 웨이퍼가 이만큼 겹치는 혐의 대상은 한 줄로 묶음 (None이면 안 묶음)
    spread_adjust: bool = True           # z가 이론보다 넓게 퍼져 있으면 그 배수만큼 기준선을 넓힘

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d):
        """웹 화면에서 받은 값을 검사해 Settings로. 모르는 키는 무시하고, 잘못된 값은 ValueError"""
        d = {f.name: d[f.name] for f in fields(cls) if f.name in d}
        blank = lambda v: v is None or (isinstance(v, str) and v.strip() in ('', 'none', 'None'))
        for k in ('max_depth', 'part_id', 'line_id', 'step_suffix', 'y_transform', 'same_wafers'):
            if k in d and blank(d[k]):
                d[k] = None
        cfg = cls(**d)
        if not isinstance(cfg.min_n, int) or cfg.min_n < 2:
            raise ValueError('MIN_N은 2 이상의 정수여야 합니다')
        if cfg.max_depth is not None and (not isinstance(cfg.max_depth, int) or cfg.max_depth < 1):
            raise ValueError('MAX_DEPTH는 1 이상의 정수이거나 제한 없음이어야 합니다')
        if cfg.y_transform not in ('auto', 'rank', 'log', None):
            raise ValueError("Value 치우침은 'auto', 'rank', 'log', 없음 중 하나여야 합니다")
        if cfg.part_adjust not in (True, 'auto', False):
            raise ValueError("part별 맞춤은 켬, 'auto', 끔 중 하나여야 합니다")
        if cfg.rework not in ('last', 'first'):
            raise ValueError("재작업 이력은 'last', 'first' 중 하나여야 합니다")
        if cfg.same_wafers is not None and not 0 < cfg.same_wafers <= 1:
            raise ValueError('같은 웨이퍼 묶기는 0보다 크고 1 이하여야 합니다')
        if not isinstance(cfg.part_min, int) or cfg.part_min < 1:
            raise ValueError('작은 part 묶기는 1 이상의 정수여야 합니다')
        return cfg
