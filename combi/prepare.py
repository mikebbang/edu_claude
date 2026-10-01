"""판정 전 준비: 치우친 Value를 순위 점수(또는 로그)로 바꾸고, part가 여럿이면 part마다 Value · bad를 맞춘다"""
import numpy as np
import pandas as pd

from .stats import anova, fmt_p, rank_scores


def prepare(data, cfg):
    """data를 판정용으로 바꾸고(data['Y'] · data['B'] · part 정보) 보정 내용을 돌려준다"""
    # ① 분포 모양: y_value가 한쪽으로 길게 치우치면 순위 점수(순위를 정규분포 점수로 옮긴 값)로 바꾼다. 순서는 그대로
    adjust_notes = []                                  # '보정:' 한 줄에 쓸 내용
    Y_NAME = 'Value' if cfg.higher_is_worse else '−Value'
    Y_input = data['Y'].copy()                         # 바꾸기 전 값 (② part별 순위 점수용)
    skew = float(pd.Series(data['Y']).skew())
    tf = ('rank' if abs(skew) > 1 else None) if cfg.y_transform == 'auto' else cfg.y_transform
    if tf not in (None, 'rank', 'log'):
        raise ValueError(f"y_transform은 'auto', 'rank', 'log', None 중 하나: {cfg.y_transform}")
    if tf == 'rank':
        data['Y'] = rank_scores(data['Y'])             # 전체 순위 점수. part별로 맞추면 ②에서 part별로 다시 매긴다
        Y_NAME += ' 순위 점수'
        adjust_notes.append(f'Value 치우침(왜도 {skew:.1f}) → 순위로 비교')
    elif tf == 'log':
        lo = data['Y'].min()
        data['Y'] = np.log(data['Y'] if lo > 0 else data['Y'] - lo + max(1e-9, 0.01 * float(np.median(data['Y'] - lo))))
        Y_NAME = f'log {Y_NAME}'
        adjust_notes.append(f'Value 치우침(왜도 {skew:.1f}) → 로그로 비교')

    # ② part별 맞춤: part마다 Value · bad의 수준과 퍼짐이 다르면 합친 판정에서 좁게 퍼진 part의 차이는 작게, 넓게 퍼진 part의 차이는
    #    크게 보인다. 그래서 part마다 맞춘다(cfg.part_adjust).
    #    Value: 순위 점수로 비교하면 part마다 순위 점수를 매긴 뒤 모아서 다시 순위 점수로 바꾼다(평균 · 퍼짐 · 모양이 part마다 같아짐).
    #           순위로 바꾸지 않으면 part마다 평균 · 표준편차를 맞춘다.
    #    bad: 조합의 실제 bad 장수를 예상 bad 장수(웨이퍼마다 자기 part의 평균 bad 비율의 합)와 비교하고 흩어짐도 part별 p(1−p)로 잰다(analyze). 초과 bad도 같은 기대치로 센다.
    #    맞춘 신호는 조합을 자기 part 평균과 비교하게 되므로 조합 z의 √(1 − …)도 part별로 계산한다(analyze · part_shrink).
    #    웨이퍼가 cfg.part_min장보다 적은 part는 하나로 묶는다
    if cfg.part_adjust not in (True, 'auto', False):
        raise ValueError(f"part_adjust는 True, 'auto', False 중 하나: {cfg.part_adjust}")
    part_table, part_lines, value_part_adjusted, bad_part_adjusted = None, [], False, False
    n_part_raw = pd.Series(data['parts']).value_counts()
    small_parts = n_part_raw.index[n_part_raw < cfg.part_min].tolist()
    groups = np.where(np.isin(data['parts'], small_parts), '(작은 part)', data['parts']).astype(object) if small_parts else data['parts']
    if len(set(groups)) > 1 and cfg.part_adjust is not False:
        table, done = {}, []
        for key_, label in (('Y', Y_NAME), ('B', 'bad 비율')):
            v = data[key_]
            if v is None:
                continue
            pg = pd.Series(v).groupby(groups)
            n_p, m_p, s_p = pg.size(), pg.mean(), pg.std()
            eta2 = float((n_p * (m_p - v.mean()) ** 2).sum()) / float(((v - v.mean()) ** 2).sum())
            an_p = anova(n_p.to_numpy(), pg.sum().to_numpy(), pg.apply(lambda x: (x * x).sum()).to_numpy())
            p_part = an_p['p'] if an_p else 1.0
            adjust = cfg.part_adjust is True or (p_part < 0.001 and eta2 >= 0.01)
            big_ = n_p >= cfg.part_min
            table['웨이퍼'], table[f'평균 {label}'] = n_p, m_p
            spread_txt = ''
            if key_ == 'Y':
                table[f'표준편차 {label}'] = s_p
                if big_.sum() > 1:
                    spread_txt = f' · 표준편차 최대 ÷ 최소 {s_p[big_].max() / s_p[big_].min():.2f}'
            part_lines.append(f'part 간 {label} 차이: 설명 비율 {eta2:.1%} · p {fmt_p(p_part)}{spread_txt} → ' + ('맞춤' if adjust else '그대로'))
            if not adjust:
                continue
            if key_ == 'Y' and tf == 'rank':            # part마다 순위 점수 → 모아서 다시 순위 점수
                data['Y'] = rank_scores(rank_scores(Y_input, groups))
                done.append('Value(part별 순위 점수 → 다시 순위 점수)')
            elif key_ == 'Y':                            # part마다 평균 · 표준편차를 맞춘다 (웨이퍼가 part_min장보다 적은 묶음은 평균만)
                sd_w = float(np.sqrt(((n_p[big_] - 1) * s_p[big_] ** 2).sum() / (n_p[big_] - 1).sum())) if big_.any() else float(v.std())
                f_ = pd.Series(groups).map((sd_w / s_p).where(big_ & (s_p > 0), 1.0)).to_numpy()
                data['Y'] = v.mean() + (v - pg.transform('mean').to_numpy()) * f_
                done.append('Value(평균 · 표준편차)')
            else:                                        # bad: part마다 bad 비율을 기대치로 (조합 z는 part별 분산으로 나눔, analyze)
                p_g = pg.transform('mean').to_numpy()
                data['B'] = v - p_g + v.mean()
                data['bad_exp'] = p_g
                done.append('bad(part별 비율 · 분산)')
        part_table = pd.DataFrame(table).sort_values('웨이퍼', ascending=False).head(10).rename_axis('part_id')
        if done:
            value_part_adjusted = any(x.startswith('Value') for x in done)
            bad_part_adjusted = any(x.startswith('bad') for x in done)
            data['part_idx'] = pd.factorize(groups)[0]
            data['part_sig'] = {k_ for k_, on in (('y', value_part_adjusted), ('b', bad_part_adjusted)) if on}
            adjust_notes.append('part별로 맞춤: ' + ' · '.join(done)
                                + (f' (웨이퍼 {cfg.part_min}장 미만 part {len(small_parts)}개는 하나로 묶음)' if small_parts else ''))
            if value_part_adjusted:
                Y_NAME += ' (part별)' if tf == 'rank' else ' (part 보정)'
    return {'tf': tf, 'skew': skew, 'notes': adjust_notes, 'part_table': part_table, 'part_lines': part_lines,
            'value_part_adjusted': value_part_adjusted, 'bad_part_adjusted': bad_part_adjusted, 'y_name': Y_NAME}
