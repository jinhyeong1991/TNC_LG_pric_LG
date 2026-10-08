// 페이지 자체 스크립트와 같은 환경(MAIN world)에서 실행된다.
// 일괄 실행 중에는 사이트가 띄우는 alert/confirm 창이 사람 없이 멈추지 않도록 자동으로 넘기고, 창 내용은 기록해 둔다.
(() => {
  try {
    const st = JSON.parse(sessionStorage.getItem('tncLgState') || 'null');
    const ld = JSON.parse(sessionStorage.getItem('tncLgLD') || 'null');
    if (!(st && st.running) && !(ld && ld.running)) return;
    const note = (m) => {
      try {
        const a = JSON.parse(sessionStorage.getItem('tncLgAlerts') || '[]');
        a.push(String(m).slice(0, 200));
        sessionStorage.setItem('tncLgAlerts', JSON.stringify(a.slice(-10)));
      } catch { /* 무시 */ }
    };
    window.alert = (m) => { note(m); };
    window.confirm = (m) => { note(m); return true; };
    window.prompt = () => null;
  } catch { /* 무시 */ }
})();
