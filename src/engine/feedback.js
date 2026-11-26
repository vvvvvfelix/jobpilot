// 闭环：按版本算漏斗 + 触发规则（查看率低 / 面试转化低 / 版本疲劳）
function ensureHistory(history) {
  const h = history || {};
  h.applied = Array.isArray(h.applied) ? h.applied : [];
  return h;
}

function responded(item) {
  return ['replied', 'interview', 'rejected'].includes(item.status);
}

function versionFunnel(history, versions) {
  const h = ensureHistory(history);
  return (versions || []).map((v) => {
    const rows = h.applied.filter((a) => a.versionId === v.id);
    const applied = rows.length;
    const replies = rows.filter(responded).length;
    const interviews = rows.filter((a) => a.status === 'interview').length;
    const rejects = rows.filter((a) => a.status === 'rejected').length;
    const silent = rows.filter((a) => !responded(a)).length;
    return {
      id: v.id,
      label: v.label,
      applied,
      replies,
      interviews,
      rejects,
      silent,
      replyRate: applied ? Math.round((replies / applied) * 100) : 0,
      interviewRate: applied ? Math.round((interviews / applied) * 100) : 0,
      atsScore: v.atsScore,
      coverage: v.keywordCoverage,
    };
  });
}

function alerts(history, versions, opts = {}) {
  const h = ensureHistory(history);
  const rows = h.applied;
  const list = [];
  const recent = rows.slice(-20);
  const replyRate = recent.length ? recent.filter(responded).length / recent.length : 1;
  if (recent.length >= 8 && replyRate < 0.3) {
    list.push({
      level: 'warn',
      signal: '查看率低',
      detail: `近 ${recent.length} 次投递回复率 ${Math.round(replyRate * 100)}%（低于 30%）`,
      action: '换一个版本再投：把摘要和技能段按目标岗位关键词重排，或者切到垂类版',
    });
  }
  const applied = rows.length;
  const interviews = rows.filter((a) => a.status === 'interview').length;
  if (applied >= 10 && interviews / applied < 0.1) {
    list.push({
      level: 'warn',
      signal: '面试转化低',
      detail: `${applied} 次投递只拿到 ${interviews} 次面试`,
      action: '版本标记「面试弱」，重点补面经与项目复盘，不必再改简历',
    });
  }
  for (const v of versions || []) {
    const ageDays = (Date.now() - (v.createdAt || Date.now())) / 86400000;
    const count = h.applied.filter((a) => a.versionId === v.id).length;
    if (ageDays > 60 && count > 100) {
      list.push({
        level: 'info',
        signal: '版本疲劳',
        detail: `${v.label} 存活 ${Math.round(ageDays)} 天、投递 ${count} 次`,
        action: '生成 v+0.1 微迭代版本做 A/B，或归档',
      });
    }
  }
  if (opts.jdMissing?.length) {
    list.push({
      level: 'info',
      signal: '技能缺口高频',
      detail: `近一批岗位里反复出现：${opts.jdMissing.slice(0, 6).join('、')}`,
      action: '这些词简历没覆盖，确实会就补一条带结果的经历，不会就别硬写',
    });
  }
  return list;
}

module.exports = { versionFunnel, alerts };
