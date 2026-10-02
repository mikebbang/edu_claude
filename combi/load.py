"""raw.csv 읽기: 웨이퍼 표 · 이력 표 · 점검 표를 만들고, 판정에 쓰는 배열(data)로 바꾼다"""
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd

from .engine import MISSING

REQUIRED = ['analysis_date', 'job_id', 'root_lot_id', 'lot_id', 'wafer_id', 'tkin_time', 'line_id', 'part_id',
            'step_seq', 'step_desc', 'eqp_id', 'chamber_id', 'ppid', 'y_value', 'good_bad', 'step_ord']
USE = [c for c in REQUIRED if c not in ('analysis_date', 'job_id', 'lot_id', 'ppid')]
GB_CODE = {'G': 0.0, 'B': 1.0}
META = ['job_id', 'analysis_date']                 # 판정에는 쓰지 않고 실행 기록에만 보여 주는 컬럼


def ord_label(o):
    return str(int(o)) if float(o).is_integer() else str(o)


def cat_values(s, f, fill=np.nan):
    """category 컬럼의 고유값에만 f를 적용해 줄마다의 값 배열로 (결측은 fill). 수백만 줄도 고유값 수만큼만 계산한다"""
    vals = np.asarray(f(pd.Series(s.cat.categories, dtype=object)))
    return np.concatenate([vals, np.array([fill]).astype(vals.dtype)])[s.cat.codes.to_numpy()]


def cat_recode(s, f):
    """category 컬럼의 고유값에 f를 적용한 새 category (바꾼 값이 같아지면 하나로 합친다)"""
    new = np.asarray(f(pd.Series(s.cat.categories, dtype=object)), dtype=object)
    ok = pd.notna(new)
    u, inv = np.unique(new[ok].astype(str), return_inverse=True)
    code = np.full(len(new) + 1, -1)
    code[np.flatnonzero(ok)] = inv
    return pd.Categorical.from_codes(code[s.cat.codes.to_numpy()], u)


def norm_wid(v):
    """wafer_id가 숫자면 '01'과 '1'을 같게 본다"""
    num = pd.to_numeric(v, errors='coerce')
    is_int = num.notna() & (num == num.round())
    out = v.copy()
    out[is_int] = num[is_int].astype(np.int64).astype(str)
    return out


def step_sort_key(s):
    return (0, float(s), s) if s.replace('.', '', 1).isdigit() else (1, 0.0, s)


def group_mode(g, codes, cats, G):
    """묶음 g(0..G-1)마다 가장 흔한 category 값 (개수가 같으면 이름순으로 앞선 값)"""
    out = np.full(G, '', dtype=object)
    ok = codes >= 0
    if ok.any():
        pk, cnt = np.unique(g[ok] * len(cats) + codes[ok], return_counts=True)
        gg, cc = pk // len(cats), pk % len(cats)
        o = np.lexsort((cc, -cnt, gg))
        first = o[np.r_[True, gg[o][1:] != gg[o][:-1]]]
        out[gg[first]] = np.asarray(cats, dtype=object)[cc[first]]
    return out


def read_raw(csv_path, cfg):
    """raw.csv를 읽어 웨이퍼 표(wf) · 이력 표(h) · 점검 표(quality) 등을 돌려준다. 확인할 점은 warnings에 모은다"""
    warnings = []
    csv_path = Path(csv_path)
    if not csv_path.exists():
        raise FileNotFoundError(f'입력 파일이 없습니다: {csv_path}')
    miss_cols = [c for c in REQUIRED if c not in pd.read_csv(csv_path, nrows=0).columns]
    if miss_cols:
        raise ValueError(f'CSV에 없는 컬럼: {miss_cols}')
    # 컬럼마다 값 종류가 줄 수보다 훨씬 적어서 category로 읽으면 메모리가 약 10분의 1로 줄고, 공백 정리 · 변환도 고유값에만 하면 된다.
    # tkin_time은 줄마다 거의 달라서 문자열로 읽어 바로 시각으로 바꾼다
    raw = pd.read_csv(csv_path, usecols=USE + META, dtype={**{c: 'category' for c in USE + META}, 'tkin_time': str})
    job = {c: sorted({str(v).strip() for v in raw[c].cat.categories}) for c in META}   # 실행 기록에 보여 줄 job_id · analysis_date
    raw = raw.drop(columns=META)
    raw['t'] = pd.to_datetime(raw.pop('tkin_time'), errors='coerce')
    for c in USE:
        if c != 'tkin_time':
            raw[c] = cat_recode(raw[c], lambda v: v.str.strip())
    n_read = len(raw)

    # 웨이퍼 키: root_lot_id와 wafer_id 코드의 쌍 (정수)
    wid = cat_recode(raw['wafer_id'], norm_wid)
    root_code, wid_code = raw['root_lot_id'].cat.codes.to_numpy().astype(np.int64), wid.codes.astype(np.int64)
    no_id = (root_code < 0) | (wid_code < 0)
    raw['wafer_key'] = root_code * (len(wid.categories) + 1) + wid_code
    n_no_id = int(no_id.sum())
    raw = raw[~no_id]

    for col, val in (('part_id', cfg.part_id), ('line_id', cfg.line_id)):
        if val is not None:
            raw = raw[raw[col] == val]

    to_num = lambda v: pd.to_numeric(v, errors='coerce').to_numpy(float)
    raw['y'] = cat_values(raw['y_value'], to_num)
    # 스텝과 오더: step_seq 끝의 '_번호'를 떼어 스텝(step_num)으로 묶고 그 번호를 오더로 쓴다. 끝 번호가 없으면 step_seq 그대로 · step_ord
    if cfg.step_suffix:
        sfx = cat_values(raw['step_seq'], lambda v: to_num(v.str.extract(cfg.step_suffix, expand=False)))
        raw['step'] = cat_recode(raw['step_seq'], lambda v: v.str.replace(cfg.step_suffix, '', regex=True))
    else:
        sfx = np.full(len(raw), np.nan)
        raw['step'] = raw['step_seq']
    step_ord = cat_values(raw['step_ord'], to_num)
    raw['ord'] = np.where(np.isnan(sfx), step_ord, sfx)
    n_ord_diff = int((~np.isnan(sfx) & ~np.isnan(step_ord) & (sfx != step_ord)).sum())
    # good_bad: G = 0, B = 1. N(과 G · B · N이 아닌 값)은 계산에서 빼고 차트에만 표시한다
    raw['gb'] = cat_recode(raw['good_bad'], lambda v: v.str.upper())
    raw['bad'] = cat_values(raw['gb'], lambda v: v.map(GB_CODE).to_numpy(float))
    gb_other = raw['gb'].value_counts(dropna=False)
    gb_other = gb_other[[k not in ('G', 'B', 'N') for k in gb_other.index] & (gb_other > 0).to_numpy()]

    # 웨이퍼 표: 웨이퍼마다 값 하나
    wf = raw.groupby('wafer_key').agg(root_lot_id=('root_lot_id', 'first'), part=('part_id', 'first'), part_n=('part_id', 'nunique'),
                                      y=('y', 'first'), y_n=('y', 'nunique'), bad=('bad', 'first'), gb=('gb', 'first'), gb_n=('gb', 'nunique'))
    wf['root_lot_id'], wf['part'] = wf['root_lot_id'].astype(object), wf['part'].astype(object)
    if not wf['y'].notna().all():
        raise ValueError(f"y_value가 비어 있거나 숫자가 아닌 웨이퍼가 {int(wf['y'].isna().sum()):,}장 있습니다. 입력을 확인하세요.")
    has_bad = bool(wf['bad'].notna().any())                 # G · B가 하나도 없으면 y_value만으로 판정 (이때는 모든 웨이퍼 사용)
    keep = wf['bad'].notna() if has_bad else pd.Series(True, index=wf.index)   # 계산에 쓰는 웨이퍼 (G · B)

    # 이력 표: 오더 · 설비가 있는 줄만. N 웨이퍼의 이력은 차트 표시용으로 따로 둔다
    h = raw.loc[raw['ord'].notna() & raw['eqp_id'].notna() & raw['step'].notna(),
                ['wafer_key', 'step', 'step_seq', 'step_desc', 'ord', 'eqp_id', 'chamber_id', 't']].copy()
    # 유닛 = eqp_id-chamber_id (chamber가 없으면 eqp_id). 설비 · 챔버 코드 쌍에서 고유한 쌍에만 이름을 붙인다
    e_cat, c_cat = h['eqp_id'].cat.categories, h['chamber_id'].cat.categories
    pair = h['eqp_id'].cat.codes.to_numpy().astype(np.int64) * (len(c_cat) + 1) + h['chamber_id'].cat.codes.to_numpy() + 1
    pairs, inv = np.unique(pair, return_inverse=True)
    names = np.array([e_cat[p // (len(c_cat) + 1)] + ('-' + c_cat[p % (len(c_cat) + 1) - 1] if p % (len(c_cat) + 1) and c_cat[p % (len(c_cat) + 1) - 1] else '')
                      for p in pairs], dtype=object)
    u_names, u_inv = np.unique(names, return_inverse=True)
    h['unit'] = pd.Categorical.from_codes(u_inv[inv], u_names)
    n_dup_keys = int(h.duplicated(['wafer_key', 'step', 'ord'], keep='first').sum())
    h = (h.sort_values('t', na_position='first' if cfg.rework == 'last' else 'last', kind='stable')
          .drop_duplicates(['wafer_key', 'step', 'ord'], keep=cfg.rework))
    h_n = h[h['wafer_key'].isin(wf.index[~keep])]           # N 웨이퍼 이력 (4절 차트에 빈 원으로만 표시)
    h = h[h['wafer_key'].isin(wf.index[keep])]
    n_value = wf.loc[~keep, 'y']                            # N 웨이퍼의 Value (원래 값)
    n_gb_n = int((~keep & (wf['gb'] == 'N')).sum())        # 계산에서 뺀 웨이퍼 중 N · 그 밖의 값
    n_gb_other = int((~keep).sum()) - n_gb_n

    INFO_ROWS = ['읽은 줄', '필터 후 줄', '웨이퍼 (root_lot_id + wafer_id)', 'good_bad가 N인 웨이퍼 (계산에서 빼고 차트에만)', '분석에 쓰는 이력 줄']
    quality = pd.DataFrame([
        ('읽은 줄', n_read),
        ('root_lot_id · wafer_id가 없어 뺀 줄', n_no_id),
        ('필터 후 줄', len(raw)),
        ('웨이퍼 (root_lot_id + wafer_id)', len(wf)),
        ('good_bad가 N인 웨이퍼 (계산에서 빼고 차트에만)', n_gb_n),
        ('good_bad가 G · B · N이 아닌 웨이퍼 (N처럼 뺌)', n_gb_other),
        ('y_value가 둘 이상인 웨이퍼 (첫 값 사용)', int((wf['y_n'] > 1).sum())),
        ('good_bad가 둘 이상인 웨이퍼 (G · B 중 첫 값 사용)', int((wf['gb_n'] > 1).sum())),
        ('part_id가 둘 이상인 웨이퍼 (첫 값 사용)', int((wf['part_n'] > 1).sum())),
        ('Order 번호 · eqp_id · step_seq가 없어 뺀 줄', int((raw['ord'].isna() | raw['eqp_id'].isna() | raw['step'].isna()).sum())),
        ('step_ord가 step_seq 끝 번호와 다른 줄 (끝 번호 사용)', n_ord_diff),
        ('tkin_time을 읽지 못한 줄', int(raw['t'].isna().sum())),
        (f"같은 웨이퍼 · STEP · Order가 겹친 줄 ('{cfg.rework}'만 남김)", n_dup_keys),
        ('분석에 쓰는 이력 줄', len(h)),
    ], columns=['항목', '값']).set_index('항목')
    if len(gb_other) and has_bad:
        warnings.append('good_bad에 G · B · N이 아닌 값이 있어 N처럼 계산에서 뺍니다: '
                        + str({(k if isinstance(k, str) else '(빈 값)'): int(v) for k, v in gb_other.head(10).items()}))
    if n_ord_diff:
        warnings.append(f'step_ord가 step_seq 끝 번호와 다른 줄이 {n_ord_diff:,}개 있습니다. Order는 step_seq 끝 번호를 씁니다.')

    # 스텝으로 묶인 모습: 오더가 많은 스텝부터
    so = h.drop_duplicates(['step', 'ord']).sort_values('ord')
    step_map = so.groupby('step').agg(
        오더=('ord', 'size'),
        오더_번호=('ord', lambda s: ', '.join(map(ord_label, s)) if len(s) <= 8 else f'{ord_label(s.iat[0])} … {ord_label(s.iat[-1])}'),
        step_seq=('step_seq', lambda s: s.iat[0] if len(s) == 1 else f'{s.iat[0]} … {s.iat[-1]}'),
        step_desc=('step_desc', lambda s: ' / '.join(list(dict.fromkeys(s.dropna()))[:3]) + (' …' if s.nunique() > 3 else '')))
    step_map = step_map.sort_values('오더', ascending=False, kind='stable').rename(columns={'오더': 'Order 수', '오더_번호': 'Order 번호', 'step_seq': 'STEP SEQ'})
    return SimpleNamespace(wf=wf, h=h, h_n=h_n, n_value=n_value, has_bad=has_bad, keep=keep, quality=quality, info_rows=INFO_ROWS,
                           so=so, step_map=step_map, n_gb_n=n_gb_n, n_gb_other=n_gb_other, warnings=warnings, job=job)


def build_data(loaded, cfg):
    """웨이퍼마다 STEP · Order별로 지난 유닛(assign) · Value · bad 배열(data)과 데이터 요약(summary)을 만든다"""
    wf, keep, h, has_bad, warnings = loaded.wf, loaded.keep, loaded.h, loaded.has_bad, loaded.warnings
    wafers = wf.index[keep]
    N = len(wafers)
    # 줄마다 (스텝 순위, 오더, 유닛)으로 한 번 정렬하고 경계만 찾아서, 스텝 · 오더마다 따로 거르지 않고 배열을 채운다
    code_of = lambda col: h[col].cat.codes.to_numpy().astype(np.int64)
    step_names = np.asarray(h['step'].cat.categories, dtype=object)
    order_ = sorted(np.unique(code_of('step')), key=lambda c: step_sort_key(step_names[c]))
    rank = np.full(len(step_names), -1)
    rank[order_] = np.arange(len(order_))
    s_arr, o_arr, u_arr = rank[code_of('step')], h['ord'].to_numpy(float), code_of('unit')
    w_arr = pd.Series(np.arange(N), index=wafers).reindex(h['wafer_key'].to_numpy()).to_numpy().astype(np.int64)
    srt = np.lexsort((u_arr, o_arr, s_arr))
    s_arr, o_arr, u_arr, w_arr = s_arr[srt], o_arr[srt], u_arr[srt], w_arr[srt]
    t_arr = h['t'].to_numpy('datetime64[ns]')[srt]
    new_g = np.r_[True, (s_arr[1:] != s_arr[:-1]) | (o_arr[1:] != o_arr[:-1])]
    g_arr = np.cumsum(new_g) - 1                            # (스텝, 오더) 묶음 번호
    G, g_start = int(g_arr[-1]) + 1, np.flatnonzero(new_g)
    new_pu = new_g | np.r_[True, u_arr[1:] != u_arr[:-1]]
    pu = np.cumsum(new_pu) - 1                              # (스텝, 오더, 유닛) 고유 쌍 번호
    local = pu - pu[g_start][g_arr]                         # 오더 안 유닛 번호 (유닛 이름순)
    assert local.max() < MISSING, '한 Order의 유닛이 너무 많습니다'
    pu_start = np.flatnonzero(new_pu)
    units_of = np.split(np.asarray(h['unit'].cat.categories, dtype=object)[u_arr[pu_start]], np.flatnonzero(np.diff(g_arr[pu_start])) + 1)
    seq_mode = group_mode(g_arr, code_of('step_seq')[srt], h['step_seq'].cat.categories, G)
    desc_mode = group_mode(g_arr, code_of('step_desc')[srt], h['step_desc'].cat.categories, G)
    proc_mode = group_mode(s_arr, code_of('step_desc')[srt], h['step_desc'].cat.categories, len(order_))
    t_int = np.where(np.isnat(t_arr), np.iinfo(np.int64).max, t_arr.view(np.int64))
    has_t = t_int != np.iinfo(np.int64).max                 # Order마다 track-in 시각: 가장 이른 시각부터 초 (없으면 -1)
    t_base = int(t_int[has_t].min()) if has_t.any() else 0
    t_sec = np.where(has_t, (t_int - t_base) // 1_000_000_000, -1)
    bounds = np.r_[np.flatnonzero(np.r_[True, s_arr[1:] != s_arr[:-1]]), len(s_arr)]
    steps, assign, trackin, tk_order = [], [], [], []
    for s_i, (r0, r1) in enumerate(zip(bounds[:-1], bounds[1:])):
        q0, q1 = g_arr[r0], g_arr[r1 - 1] + 1
        A = np.full((q1 - q0, N), MISSING, dtype=np.uint16)
        A[g_arr[r0:r1] - q0, w_arr[r0:r1]] = local[r0:r1]
        TK = np.full((q1 - q0, N), -1, dtype=np.int32)
        TK[g_arr[r0:r1] - q0, w_arr[r0:r1]] = t_sec[r0:r1]
        first_t = np.full(N, np.iinfo(np.int64).max)
        np.minimum.at(first_t, w_arr[r0:r1], t_int[r0:r1])   # 웨이퍼마다 이 스텝의 첫 track-in
        tk = first_t.view('datetime64[ns]').copy()
        tk[first_t == np.iinfo(np.int64).max] = np.datetime64('NaT', 'ns')
        seqs = [{'name': f'O{ord_label(o_arr[g_start[g]])}', 'ord': float(o_arr[g_start[g]]), 'units': list(units_of[g]),
                 'seq': seq_mode[g], 'desc': desc_mode[g]} for g in range(q0, q1)]
        steps.append({'index': s_i, 'name': str(step_names[order_[s_i]]), 'proc': proc_mode[s_i], 'seqs': seqs})
        assign.append(A)
        trackin.append(tk)
        tk_order.append(TK)

    Y = wf.loc[wafers, 'y'].to_numpy(float)
    if not cfg.higher_is_worse:
        Y = -Y                                     # 작을수록 나쁜 값은 부호를 뒤집어 '클수록 나쁨'으로 맞춘다
    if not (N >= 2 * cfg.min_n and Y.std() > 0):
        raise ValueError(f'비교할 수 없습니다: 웨이퍼 {N}장, Value 표준편차 {Y.std():.3g}')
    B = wf.loc[wafers, 'bad'].to_numpy(float) if has_bad else None
    if B is None:
        warnings.append('good_bad에 G · B가 없어 Value만으로 판정합니다 (모든 웨이퍼 사용).')
    elif B.std() == 0:
        warnings.append(f'good_bad가 한쪽뿐입니다 (bad 비율 {B.mean():.0%}). 양품 · 불량 웨이퍼가 함께 있어야 비교할 수 있어서 Value만으로 판정합니다.')
        B = None
    lots = wf.loc[wafers, 'root_lot_id'].to_numpy()
    lot_idx, lot_names = pd.factorize(lots)
    data = {'N': N, 'Y': Y, 'B': B, 'steps': steps, 'assign': assign, 'trackin': trackin, 'wafers': wafers,
            'lots': lots, 'lot_idx': lot_idx, 'n_lots': len(lot_names), 'parts': wf.loc[wafers, 'part'].fillna('').to_numpy(),
            'bad': wf.loc[wafers, 'bad'].to_numpy(float),
            'value': wf.loc[wafers, 'y'].to_numpy(float), 'tk': tk_order, 't_base': np.datetime64(t_base, 'ns')}
    issues = int((loaded.quality['값'].drop(loaded.info_rows) > 0).sum())
    summary = {'wafers': N, 'n_gb_n': loaded.n_gb_n, 'n_gb_other': loaded.n_gb_other, 'n_excluded': len(loaded.n_value),
               'lots': data['n_lots'], 'steps': len(steps), 'step_seqs': int(loaded.so['step_seq'].nunique()),
               'orders': sum(len(s['seqs']) for s in steps), 'bad_rate': float(np.nanmean(data['bad'])) if B is not None else None,
               'issues': issues, 'job_ids': loaded.job['job_id'], 'analysis_dates': loaded.job['analysis_date']}
    return data, summary
