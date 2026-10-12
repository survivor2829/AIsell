(() => {
  const element = id => document.getElementById(id);
  const form = element('tutorial-form');
  const field = name => form.elements.namedItem(name);
  let catalog;
  let uploadRequest;
  const notice = text => { element('tutorial-notice').textContent = text; };
  function cell(row, text) { const td = document.createElement('td'); td.textContent = text; row.append(td); return td; }
  function topics() {
    element('tutorial-topic-label').hidden = field('category').value !== 'short-video';
    if (field('category').value !== 'short-video') field('topic').value = '';
  }
  function reset() { form.reset(); ['id', 'existingVideo', 'existingCover'].forEach(name => { field(name).value = ''; }); topics(); }
  async function change(body) {
    const response = await fetch('/api/tutorials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw Error('教程未保存，请检查必填信息和上传文件后重试。');
    await load();
  }
  async function load() {
    const response = await fetch('/api/tutorials');
    if (!response.ok) throw Error('教程目录暂时无法读取，请重试。');
    catalog = await response.json();
    if (!field('category').options.length) {
      field('category').replaceChildren(...catalog.categories.map(row => new Option(row.label, row.id)));
      field('topic').replaceChildren(new Option('基础操作', ''), ...catalog.topics.map(row => new Option(row.label, row.id)));
    }
    element('tutorial-items').replaceChildren();
    for (const item of catalog.items) {
      const tr = document.createElement('tr');
      cell(tr, item.title);
      cell(tr, [catalog.categories.find(row => row.id === item.category)?.label, catalog.topics.find(row => row.id === item.topic)?.label].filter(Boolean).join(' / '));
      cell(tr, Math.floor(item.video.durationSeconds / 60) + ':' + String(Math.floor(item.video.durationSeconds % 60)).padStart(2, '0'));
      cell(tr, item.published ? '已发布' : '草稿 / 已下架');
      const operations = cell(tr, '');
      const preview = document.createElement('button'); preview.type = 'button'; preview.textContent = '预览';
      preview.onclick = () => {
        element('tutorial-preview').hidden = false;
        element('tutorial-preview-title').textContent = item.title;
        const video = element('tutorial-preview-video');
        video.poster = item.cover.url.replace('/v1/tutorials/', '/api/tutorials/');
        video.src = item.video.url.replace('/v1/tutorials/', '/api/tutorials/');
        element('tutorial-preview').scrollIntoView({ block: 'nearest' });
      };
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '修改';
      edit.onclick = () => {
        reset(); ['id', 'title', 'category', 'topic'].forEach(name => { field(name).value = item[name]; });
        field('existingVideo').value = item.video.url.split('/').pop();
        field('existingCover').value = item.cover.url.split('/').pop();
        topics(); field('title').focus();
        notice('正在修改“' + item.title + '”。不重新选文件则沿用原录屏和封面；保存后需要重新发布。');
      };
      const publish = document.createElement('button'); publish.type = 'button'; publish.textContent = item.published ? '下架' : '发布';
      publish.onclick = async () => {
        publish.disabled = true;
        try { await change({ action: item.published ? 'unpublish' : 'publish', id: item.id }); notice(item.published ? '已下架，客户刷新后不再新增播放；已准备的本地文件保留。' : '已发布，客户刷新操作教程即可看到。'); }
        catch (error) { notice(error.message); } finally { publish.disabled = false; }
      };
      operations.append(preview, document.createTextNode(' '), edit, document.createTextNode(' '), publish);
      element('tutorial-items').append(tr);
    }
    if (!catalog.items.length) { const tr = document.createElement('tr'); const td = cell(tr, '还没有录屏。上传第一段单项操作教程后，先预览再发布。'); td.colSpan = 5; element('tutorial-items').append(tr); }
    topics();
  }
  function recordingDuration(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video'); const url = URL.createObjectURL(file);
      const timer = setTimeout(() => done(new Error('无法读取录屏，请导出为 H.264 MP4 后重试。')), 15000);
      function done(error) { clearTimeout(timer); video.onloadedmetadata = null; video.onerror = null; video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); if (error) reject(error); }
      video.preload = 'metadata';
      video.onloadedmetadata = () => { const seconds = video.duration; done(); Number.isFinite(seconds) && seconds > 0 && seconds <= 305 ? resolve(seconds) : reject(Error('请将录屏拆成每段不超过 5 分钟的单项操作。')); };
      video.onerror = () => done(new Error('录屏无法播放，请导出为 H.264 MP4 后重试。'));
      video.src = url;
    });
  }
  function upload(file, kind, contentType) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); uploadRequest = xhr;
      xhr.open('POST', '/api/tutorials/files?kind=' + kind);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = event => { if (event.lengthComputable) element('tutorial-progress').value = Math.round(event.loaded / event.total * 100); };
      xhr.onerror = () => reject(Error('上传中断，请检查 SSH 隧道后重新上传。'));
      xhr.onabort = () => reject(Error('已取消上传，当前发布的教程未改变。'));
      xhr.onload = () => {
        uploadRequest = null;
        if (xhr.status !== 200) return reject(Error('文件未保存。录屏请使用 H.264 编码的 MP4，单段不超过 5 分钟、256 MiB；封面使用 PNG 或 JPG。'));
        try { resolve(JSON.parse(xhr.responseText)); } catch { reject(Error('上传结果未确认，请重试。')); }
      };
      xhr.send(file);
    });
  }
  form.onsubmit = async event => {
    event.preventDefault();
    const video = field('video').files[0], cover = field('cover').files[0];
    let videoName = field('existingVideo').value, coverName = field('existingCover').value;
    const inputs = [...form.elements].filter(input => input.id !== 'tutorial-cancel');
    inputs.forEach(input => { input.disabled = true; });
    try {
      if ((!video && !videoName) || (!cover && !coverName)) throw Error('请选择操作录屏和封面。');
      if (video && (!/\.mp4$/i.test(video.name) || video.size > 256 * 1024 * 1024 || !video.size)) throw Error('录屏需为不超过 256 MiB 的 MP4。');
      if (cover && (!/\.(png|jpe?g)$/i.test(cover.name) || cover.size > 2 * 1024 * 1024 || !cover.size)) throw Error('封面需为不超过 2 MiB 的 PNG 或 JPG。');
      if (video) await recordingDuration(video);
      element('tutorial-progress').hidden = false; element('tutorial-cancel').hidden = false;
      if (video) { notice('正在上传录屏…'); videoName = (await upload(video, 'video', 'video/mp4')).file; field('existingVideo').value = videoName; }
      if (cover) { notice('正在上传封面…'); coverName = (await upload(cover, 'cover', /\.png$/i.test(cover.name) ? 'image/png' : 'image/jpeg')).file; field('existingCover').value = coverName; }
      await change({ action: 'save', id: field('id').value || crypto.randomUUID(), title: field('title').value, category: field('category').value, topic: field('topic').value, video: videoName, cover: coverName });
      reset(); notice('草稿已保存。请点击“预览”检查画面和声音，再点击“发布”。');
    } catch (error) { notice(error.message); }
    finally { inputs.forEach(input => { input.disabled = false; }); element('tutorial-progress').hidden = true; element('tutorial-cancel').hidden = true; uploadRequest = null; }
  };
  field('category').onchange = topics;
  element('tutorial-reset').onclick = reset;
  element('tutorial-cancel').onclick = () => uploadRequest?.abort();
  element('tutorial-close-preview').onclick = () => { const video = element('tutorial-preview-video'); video.pause(); video.removeAttribute('src'); video.load(); element('tutorial-preview').hidden = true; };
  void load().catch(error => notice(error.message));
})();
