/* main.js - Doctor's Occlusion (Phase 9.2: Hint Logic Fix) */
const obsidian = require('obsidian');
const { clipboard } = require('electron');

// --- MODALES ---
class ImageSuggestModal extends obsidian.FuzzySuggestModal {
    constructor(app, onChoose) { super(app); this.onChoose = onChoose; }
    getItems() {
        return this.app.vault.getFiles()
            .filter(f => ['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(f.extension.toLowerCase()))
            .sort((a, b) => b.stat.mtime - a.stat.mtime);
    }
    getItemText(file) { return file.path; }
    onChooseItem(file) { this.onChoose(file); }
}

class LabelEditModal extends obsidian.Modal {
    constructor(app, currentText, onSubmit) { super(app); this.currentText = currentText; this.onSubmit = onSubmit; }
    onOpen() {
        const { contentEl } = this; contentEl.createEl("h3", { text: "Edit" });
        const input = contentEl.createEl("input", { type: "text", value: this.currentText, attr: { placeholder: "Ej: Ramas del Trigémino" } });
        input.style.width = "100%"; input.style.marginBottom = "15px"; input.focus(); input.select();
        const btnSave = contentEl.createEl("button", { text: "Save", cls: "mod-cta" }); btnSave.style.float = "right";
        btnSave.onclick = () => { this.onSubmit(input.value); this.close(); };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { this.onSubmit(input.value); this.close(); } });
    }
    onClose() { this.contentEl.empty(); }
}

// --- MODAL MODO ZEN ---
class DoctorFullscreenModal extends obsidian.Modal {
    constructor(app, imgFile, initialRects, onSave) {
        super(app);
        this.imgFile = imgFile;
        this.rects = JSON.parse(JSON.stringify(initialRects)); 
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        this.modalEl.addClass("doctor-zen-modal"); 
        const container = contentEl.createDiv({ style: "display: flex; flex-direction: column; height: 100%;" });
        const controls = container.createDiv({ cls: "doctor-controls", style: "padding: 15px; border-bottom: 2px solid #333;" });
        const workspace = container.createDiv({ cls: "doctor-zen-workspace" });
        
        const imgPath = this.app.vault.getResourcePath(this.imgFile);
        const imgObj = new Image(); imgObj.src = imgPath;

        const canvas = workspace.createEl("canvas", { style: "display: block;" });
        const ctx2d = canvas.getContext("2d");

        let rects = this.rects;
        let mode = 'edit';
        let isDrawing = false; let startX, startY;
        let scale = 1.0; let panX = 0; let panY = 0; let isPanning = false; let panStartX, panStartY;
        let studyGroups = []; let currentGroupIdx = 0; let isRevealed = false; let isRandom = false; 
        let currentShape = 'rect';
        let isGrouping = false; let activeGroupID = null;

        // BOTONES ZEN
        const btnClose = controls.createEl("button", { cls: "doctor-btn", text: "❌ Close" });
        btnClose.style.marginRight = "auto"; btnClose.onclick = () => this.close();

        const btnMode = controls.createEl("button", { cls: "doctor-btn primary", text: "▶ Study" });
        const btnGroup = controls.createEl("button", { cls: "doctor-btn", text: "🔗 Agrupar: OFF" });
        btnGroup.onclick = () => { isGrouping = !isGrouping; if (isGrouping) { activeGroupID = `G_${Date.now()}`; btnGroup.innerText = "🔗 Agrupar: ON"; btnGroup.classList.add("primary"); } else { activeGroupID = null; btnGroup.innerText = "🔗 Agrupar: OFF"; btnGroup.classList.remove("primary"); } };
        
        const btnShape = controls.createEl("button", { cls: "doctor-btn", text: "⬛" });
        btnShape.onclick = () => { currentShape = currentShape === 'rect' ? 'circle' : 'rect'; btnShape.innerText = currentShape === 'rect' ? "⬛" : "🔴"; };
        
        const btnRandom = controls.createEl("button", { cls: "doctor-btn", text: "🎲" });
        btnRandom.onclick = () => { isRandom = !isRandom; btnRandom.classList.toggle("primary", isRandom); };
        
        const btnSave = controls.createEl("button", { cls: "doctor-btn", text: "💾 Save" });
        btnSave.onclick = () => { this.onSave(rects); new obsidian.Notice("✅ Saved from Zen Mode"); };
        
        const btnUndo = controls.createEl("button", { cls: "doctor-btn", text: "↩" });
        const btnFit = controls.createEl("button", { cls: "doctor-btn", text: "🔍 Center" });
        
        const statusText = controls.createEl("span", { text: "", style: "margin-left:10px; font-weight:bold; color: white;" });
        
        const btnReveal = controls.createEl("button", { cls: "doctor-btn danger", text: "Show" });
        const btnNext = controls.createEl("button", { cls: "doctor-btn", text: "Next" });
        btnReveal.style.display = "none"; btnNext.style.display = "none";

        const fitImage = () => {
            const w = workspace.clientWidth; const h = workspace.clientHeight;
            if (imgObj.width === 0) return;
            const scaleW = w / imgObj.width; const scaleH = h / imgObj.height;
            scale = Math.min(scaleW, scaleH) * 0.9; 
            panX = (w - imgObj.width * scale) / 2; panY = (h - imgObj.height * scale) / 2;
            draw();
        };
        btnFit.onclick = fitImage;

        const resizeObserver = new ResizeObserver(() => { canvas.width = workspace.clientWidth; canvas.height = workspace.clientHeight; draw(); });
        resizeObserver.observe(workspace);
        imgObj.onload = () => { canvas.width = workspace.clientWidth; canvas.height = workspace.clientHeight; fitImage(); };

        const toImageCoords = (clientX, clientY) => {
            const rect = canvas.getBoundingClientRect();
            return { x: (clientX - rect.left - panX) / scale, y: (clientY - rect.top - panY) / scale };
        };

        const updateCursor = (e) => {
            if (mode !== 'edit') { workspace.style.cursor = "default"; return; }
            if (isPanning) { workspace.style.cursor = "grabbing"; return; }
            if (e && e.ctrlKey) { workspace.style.cursor = "crosshair"; } 
            else { workspace.style.cursor = "grab"; }
        };

        const draw = () => {
            ctx2d.setTransform(1, 0, 0, 1, 0, 0); ctx2d.clearRect(0, 0, canvas.width, canvas.height);
            if (!imgObj.complete) return;
            ctx2d.setTransform(scale, 0, 0, scale, panX, panY);
            ctx2d.drawImage(imgObj, 0, 0);

            const drawShape = (r, color, isStroke) => {
                const x = r.x; const y = r.y; const w = r.w; const h = r.h;
                ctx2d.fillStyle = color; ctx2d.strokeStyle = "rgba(255,255,255,0.9)"; ctx2d.lineWidth = 2 / scale;
                ctx2d.beginPath();
                if (r.type === 'circle') ctx2d.ellipse(x + w/2, y + h/2, Math.abs(w/2), Math.abs(h/2), 0, 0, 2 * Math.PI);
                else ctx2d.rect(x, y, w, h);
                if (isStroke) { ctx2d.fill(); ctx2d.stroke(); } else { ctx2d.fill(); }
                if (mode === 'edit' && r.group) { ctx2d.fillStyle = "#3498db"; ctx2d.font = `bold ${20/scale}px sans-serif`; ctx2d.fillText("🔗", x + w, y); }
            };

            const drawLabel = (r) => {
                if (r.label) {
                    const x = r.x; const y = r.y; const w = r.w; const h = r.h;
                    ctx2d.fillStyle = "white"; ctx2d.font = `bold ${16/scale}px sans-serif`;
                    ctx2d.textAlign = "center"; ctx2d.textBaseline = "middle"; ctx2d.strokeStyle = "black"; ctx2d.lineWidth = 3 / scale;
                    ctx2d.strokeText(r.label, x + w/2, y + h/2); ctx2d.fillText(r.label, x + w/2, y + h/2);
                }
            };

            if (mode === 'edit') {
                rects.forEach(r => drawShape(r, r.group ? "rgba(52, 152, 219, 0.4)" : "rgba(255, 60, 60, 0.4)", true));
                rects.forEach(r => drawLabel(r));
            } else {
                const activeIndices = studyGroups[currentGroupIdx] || [];
                rects.forEach((r, i) => {
                    if (activeIndices.includes(i)) {
                        if (!isRevealed) drawShape(r, "rgba(255, 165, 0, 1)", false);
                    } else { drawShape(r, "rgba(255, 60, 60, 1)", false); }
                });
                
                // CORRECCIÓN: Solo dibujar etiqueta si es la activa Y NO está revelada
                rects.forEach((r, i) => {
                    if (activeIndices.includes(i) && !isRevealed && r.label) drawLabel(r);
                });
            }
        };

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault(); const delta = e.deltaY > 0 ? -0.1 : 0.1; const newScale = scale * (1 + delta);
            if (newScale < 0.1 || newScale > 20) return;
            const rect = canvas.getBoundingClientRect(); const mouseX = e.clientX - rect.left; const mouseY = e.clientY - rect.top;
            panX = mouseX - (mouseX - panX) * (newScale / scale); panY = mouseY - (mouseY - panY) * (newScale / scale);
            scale = newScale; draw();
        });

        canvas.addEventListener('mousedown', (e) => {
            if (mode === 'edit' && e.button === 0 && e.ctrlKey) {
                const coords = toImageCoords(e.clientX, e.clientY); startX = coords.x; startY = coords.y; isDrawing = true; return;
            }
            if (e.button === 1 || (e.button === 0 && !e.ctrlKey)) {
                isPanning = true; panStartX = e.clientX - panX; panStartY = e.clientY - panY; workspace.style.cursor = "grabbing"; e.preventDefault(); return;
            }
        });

        canvas.addEventListener('mousemove', (e) => {
            updateCursor(e);
            if (isPanning) { panX = e.clientX - panStartX; panY = e.clientY - panStartY; draw(); return; }
            if (!isDrawing || mode !== 'edit') return;
            draw(); const coords = toImageCoords(e.clientX, e.clientY); const w = coords.x - startX; const h = coords.y - startY;
            ctx2d.setTransform(scale, 0, 0, scale, panX, panY); ctx2d.fillStyle = "rgba(255, 0, 0, 0.3)"; ctx2d.strokeStyle = "white"; ctx2d.lineWidth = 1 / scale;
            ctx2d.beginPath(); if (currentShape === 'rect') ctx2d.rect(startX, startY, w, h); else ctx2d.ellipse(startX + w/2, startY + h/2, Math.abs(w/2), Math.abs(h/2), 0, 0, 2 * Math.PI); ctx2d.fill(); ctx2d.stroke();
        });

        canvas.addEventListener('mouseup', (e) => {
            if (isPanning) { isPanning = false; updateCursor(e); return; }
            if (!isDrawing || mode !== 'edit') return; isDrawing = false;
            const coords = toImageCoords(e.clientX, e.clientY); const w = coords.x - startX; const h = coords.y - startY;
            if (Math.abs(w) < 5/scale && Math.abs(h) < 5/scale) { draw(); return; }
            rects.push({ x: startX, y: startY, w: w, h: h, type: currentShape, label: "", group: isGrouping ? activeGroupID : null }); draw();
        });

        window.addEventListener('keydown', (e) => { if(e.key === "Control") updateCursor(e); });
        window.addEventListener('keyup', (e) => { if(e.key === "Control") updateCursor(e); });

        canvas.addEventListener('contextmenu', (e) => {
            if (mode !== 'edit') return; e.preventDefault(); const coords = toImageCoords(e.clientX, e.clientY); const clickX = coords.x; const clickY = coords.y;
            for (let i = rects.length - 1; i >= 0; i--) {
                const r = rects[i]; const x1 = Math.min(r.x, r.x + r.w); const x2 = Math.max(r.x, r.x + r.w); const y1 = Math.min(r.y, r.y + r.h); const y2 = Math.max(r.y, r.y + r.h);
                if (clickX >= x1 && clickX <= x2 && clickY >= y1 && clickY <= y2) {
                    const menu = new obsidian.Menu(); menu.addItem((item) => { item.setTitle("✏️ Edit").setIcon("pencil").onClick(() => { new LabelEditModal(this.app, r.label, (t) => { r.label = t; draw(); }).open(); }); });
                    if (r.group) { menu.addItem((item) => { item.setTitle("🔗 Ungroup").setIcon("link").onClick(() => { r.group = null; draw(); }); }); } else if (isGrouping) { menu.addItem((item) => { item.setTitle("🔗 Group").setIcon("link").onClick(() => { r.group = activeGroupID; draw(); }); }); }
                    menu.addItem((item) => { item.setTitle("🗑️ Delete").setIcon("trash").setWarning(true).onClick(() => { rects.splice(i, 1); draw(); }); }); menu.showAtPosition({ x: e.clientX, y: e.clientY }); return;
                }
            }
        });

        btnUndo.onclick = () => { rects.pop(); draw(); };
        btnMode.onclick = () => {
            if (mode === 'edit') {
                if(rects.length === 0) return new obsidian.Notice("Draw squares first"); 
                mode = 'study';
                const groupsMap = {}; const noGroupIndices = []; rects.forEach((r, idx) => { if (r.group) { if (!groupsMap[r.group]) groupsMap[r.group] = []; groupsMap[r.group].push(idx); } else { noGroupIndices.push(idx); } });
                studyGroups = []; Object.values(groupsMap).forEach(indices => studyGroups.push(indices)); noGroupIndices.forEach(idx => studyGroups.push([idx]));
                if (isRandom) studyGroups.sort(() => Math.random() - 0.5); 
                currentGroupIdx = 0; isRevealed = false;
                btnMode.innerText = "✏ Edit"; btnMode.classList.remove("primary"); 
                [btnUndo, btnSave, btnShape, btnRandom, btnGroup, btnFit].forEach(b => b.style.display = "none");
                btnReveal.style.display = "inline-block";
                draw();
            } else {
                mode = 'edit'; btnMode.innerText = "▶ Study"; btnMode.classList.add("primary"); 
                [btnUndo, btnSave, btnShape, btnRandom, btnGroup, btnFit].forEach(b => b.style.display = "inline-block");
                btnReveal.style.display = "none"; btnNext.style.display = "none"; statusText.innerText = ""; draw();
            }
            updateCursor();
        };

        const reveal = () => { isRevealed = true; btnReveal.style.display = "none"; btnNext.style.display = "inline-block"; draw(); };
        const next = () => { if (currentGroupIdx < studyGroups.length - 1) { currentGroupIdx++; isRevealed = false; btnReveal.style.display = "inline-block"; btnNext.style.display = "none"; draw(); } else { new obsidian.Notice("Review complete!"); btnMode.click(); } };
        btnReveal.onclick = reveal; btnNext.onclick = next;
        container.tabIndex = 0; container.focus();
        container.onkeydown = (e) => { if (mode === 'study') { if (e.code === 'Space') { e.preventDefault(); if(!isRevealed) reveal(); } if (e.code === 'Enter' || e.code === 'ArrowRight') { e.preventDefault(); if(isRevealed) next(); } } else { if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); btnUndo.click(); } } };
    }
    onClose() { this.contentEl.empty(); }
}

const DOCTOR_VIEW_ID = "doctor-atlas-view";
class DoctorAtlasView extends obsidian.ItemView {
    constructor(leaf) { super(leaf); }
    getViewType() { return DOCTOR_VIEW_ID; }
    getDisplayText() { return "Atlas"; }
    getIcon() { return "activity"; }
    async onOpen() {
        const container = this.containerEl.children[1]; container.empty();
        container.createEl("h2", { text: "🗂️ Atlas", style: "text-align: center; margin-bottom: 20px;" });
        const grid = container.createDiv({ style: "display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 20px; padding: 10px;" });
        const files = this.app.vault.getMarkdownFiles(); let cardCount = 0;
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache || !cache.sections) continue;
            const doctorBlocks = cache.sections.filter(sec => sec.type === 'code');
            if (doctorBlocks.length === 0) continue;
            const content = await this.app.vault.read(file);
            const regex = /```doctor\n([\s\S]*?)\n```/g; let match;
            while ((match = regex.exec(content)) !== null) {
                try { const data = JSON.parse(match[1]); if (!data.image) continue; this.renderThumbnail(grid, file, data); cardCount++; } catch (e) {}
            }
        }
        if (cardCount === 0) grid.createEl("p", { text: "Empty atlas", style: "grid-column: 1/-1; text-align: center; color: var(--text-muted);" });
    }
    renderThumbnail(container, file, data) {
        const card = container.createDiv({ cls: "nav-file-title", style: "border: 1px solid var(--background-modifier-border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; cursor: pointer; transition: transform 0.2s;" });
        card.onmouseover = () => card.style.transform = "scale(1.03)"; card.onmouseout = () => card.style.transform = "scale(1)";
        const imgContainer = card.createDiv({ style: "height: 150px; overflow: hidden; background: #202020; display: flex; align-items: center; justify-content: center;" });
        const imgFile = this.app.metadataCache.getFirstLinkpathDest(data.image, file.path);
        if (imgFile) { const imgPath = this.app.vault.getResourcePath(imgFile); imgContainer.createEl("img", { attr: { src: imgPath }, style: "width: 100%; height: 100%; object-fit: contain; opacity: 0.9;" }); }
        else { imgContainer.createEl("div", { text: "⚠️", style: "font-size: 2em;" }); }
        const title = card.createDiv({ style: "padding: 10px; background: var(--background-secondary); font-weight: bold; font-size: 0.85em; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" });
        title.innerText = file.basename;
        card.onclick = async () => { const leaf = this.app.workspace.getLeaf(false); await leaf.openFile(file); };
    }
}

// --- PLUGIN PRINCIPAL ---
module.exports = class DoctorOcclusionPlugin extends obsidian.Plugin {
    async onload() {
        this.registerView(DOCTOR_VIEW_ID, (leaf) => new DoctorAtlasView(leaf));
        this.addRibbonIcon('microscope', 'Open Atlas', () => { this.activateView(); });
        this.registerMarkdownCodeBlockProcessor("doctor", (source, el, ctx) => { this.renderDoctorBlock(source, el, ctx); });
        this.addCommand({ id: 'insert-doctor-card', name: 'Insert Empty Card', editorCallback: (editor) => { editor.replaceSelection('```doctor\n' + JSON.stringify({ image: "", rects: [] }, null, 2) + '\n```'); } });
        this.addCommand({
            id: 'insert-doctor-card-paste', name: 'Paste image (Clip)',
            editorCallback: async (editor) => {
                try {
                    const nativeImage = clipboard.readImage();
                    if (nativeImage.isEmpty()) { new obsidian.Notice("❌ Empty Clipboard"); return; }
                    const phText = `⏳ Generating card... [DOC_${Date.now()}]`; editor.replaceSelection(phText);
                    const arrayBuffer = nativeImage.toPNG(); const baseName = `doctor-card-${Date.now()}`; const activeFile = this.app.workspace.getActiveFile();
                    let folderPath = `${baseName}.png`; try { folderPath = await this.app.vault.getAvailablePathForAttachments(baseName, "png", activeFile); } catch (e) {}
                    await this.app.vault.createBinary(folderPath, arrayBuffer);
                    const finalBlock = '```doctor\n' + JSON.stringify({ image: folderPath, rects: [] }, null, 2) + '\n```';
                    const docContent = editor.getValue(); const idx = docContent.indexOf(phText);
                    if (idx !== -1) editor.replaceRange(finalBlock, editor.offsetToPos(idx), editor.offsetToPos(idx + phText.length)); else editor.replaceSelection(finalBlock);
                    new obsidian.Notice(`📸 Card created`);
                } catch (err) { new obsidian.Notice("Error: " + err.message); }
            }
        });
    }
    async activateView() {
        const { workspace } = this.app; let leaf = workspace.getLeavesOfType(DOCTOR_VIEW_ID)[0];
        if (!leaf) { const rightLeaf = workspace.getRightLeaf(false); if (rightLeaf) { await rightLeaf.setViewState({ type: DOCTOR_VIEW_ID, active: true }); leaf = workspace.getLeavesOfType(DOCTOR_VIEW_ID)[0]; } }
        if (leaf) workspace.revealLeaf(leaf);
    }
    async updateBlockData(el, ctx, newData) {
        const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView); if (!view) return;
        const section = ctx.getSectionInfo(el); if (!section) return; const editor = view.editor;
        editor.replaceRange(JSON.stringify(newData, null, 2), { line: section.lineStart + 1, ch: 0 }, { line: section.lineEnd - 1, ch: editor.getLine(section.lineEnd - 1).length });
    }
    async renderDoctorBlock(source, el, ctx) {
        let data; try { data = JSON.parse(source); } catch (e) { el.createEl("h3", { text: "Error JSON" }); return; }
        const container = el.createDiv({ cls: "doctor-occlusion-container" });
        if (!data.image) { this.renderEmptyState(container, data, el, ctx); return; }
        const file = this.app.metadataCache.getFirstLinkpathDest(data.image, ctx.sourcePath);
        if (!file) { this.renderErrorState(container, data, el, ctx); return; }
        this.renderInterface(container, file, data, el, ctx);
    }
    renderEmptyState(container, data, el, ctx) {
        const es = container.createDiv({ cls: "doctor-empty-state" }); es.createDiv({ cls: "doctor-empty-icon", text: "🖼️" }); es.createEl("h3", { text: "Empty card" });
        const bg = es.createDiv({ style: "display: flex; gap: 10px;" });
        bg.createEl("button", { cls: "doctor-btn primary", text: "📂 Select" }).onclick = () => { new ImageSuggestModal(this.app, (f) => { data.image = f.path; this.updateBlockData(el, ctx, data); }).open(); };
    }
    renderErrorState(container, data, el, ctx) { container.createDiv({ cls: "doctor-empty-state" }).createEl("button", { cls: "doctor-btn", text: "🔄 Reset" }).onclick = () => { data.image = ""; this.updateBlockData(el, ctx, data); }; }

    // --- LÓGICA PRINCIPAL (VISTA NORMAL) ---
    renderInterface(container, file, data, el, ctx) {
        const controls = container.createDiv({ cls: "doctor-controls" });
        const workspace = container.createDiv({ cls: "doctor-workspace" });

        const imgPath = this.app.vault.getResourcePath(file);
        const imgObj = new Image(); imgObj.src = imgPath;

        const canvas = workspace.createEl("canvas", { cls: "doctor-occlusion-canvas" });
        const ctx2d = canvas.getContext("2d");

        let rects = data.rects || []; let isDrawing = false; let startX, startY; let mode = 'edit';
        let studyGroups = []; let currentGroupIdx = 0; let isRevealed = false; let isRandom = false; let currentShape = 'rect';
        
        let isGrouping = false; 
        let activeGroupID = null; 
        
        let scale = 1.0; let panX = 0; let panY = 0; let isPanning = false; let panStartX, panStartY;

        const btnMode = controls.createEl("button", { cls: "doctor-btn primary", text: "▶ Study" });
        const btnGroup = controls.createEl("button", { cls: "doctor-btn", text: "🔗 Group: OFF" });
        btnGroup.onclick = () => { isGrouping = !isGrouping; if (isGrouping) { activeGroupID = `G_${Date.now()}`; btnGroup.innerText = "🔗 Group: ON"; btnGroup.classList.add("primary"); } else { activeGroupID = null; btnGroup.innerText = "🔗 Group: OFF"; btnGroup.classList.remove("primary"); } };
        const btnShape = controls.createEl("button", { cls: "doctor-btn", text: "⬛" });
        btnShape.onclick = () => { currentShape = currentShape === 'rect' ? 'circle' : 'rect'; btnShape.innerText = currentShape === 'rect' ? "⬛" : "🔴"; };
        const btnRandom = controls.createEl("button", { cls: "doctor-btn", text: "🎲" });
        btnRandom.onclick = () => { isRandom = !isRandom; btnRandom.classList.toggle("primary", isRandom); };
        const btnSave = controls.createEl("button", { cls: "doctor-btn", text: "💾" });
        const btnUndo = controls.createEl("button", { cls: "doctor-btn", text: "↩" });
        const btnExpand = controls.createEl("button", { cls: "doctor-btn", text: "⤢" });
        btnExpand.onclick = () => {
            new DoctorFullscreenModal(this.app, file, rects, (newRects) => {
                rects = newRects; data.rects = rects; this.updateBlockData(el, ctx, data); draw();
            }).open();
        };

        const btnFit = controls.createEl("button", { cls: "doctor-btn", text: "🔍 Fit" });
        
        const statusText = controls.createEl("span", { text: "", style: "margin-left:10px; font-weight:bold; font-size:0.9em;" });
        const btnReveal = controls.createEl("button", { cls: "doctor-btn danger", text: "Show" });
        const btnNext = controls.createEl("button", { cls: "doctor-btn", text: "Next" });
        btnReveal.style.display = "none"; btnNext.style.display = "none";

        const setNaturalSize = () => {
            if (imgObj.width === 0) return;
            const containerWidth = workspace.clientWidth;
            if (containerWidth === 0) return;
            let naturalHeight = containerWidth * (imgObj.height / imgObj.width);
            if (naturalHeight < 500) naturalHeight = 500;
            canvas.width = containerWidth; canvas.height = naturalHeight;
            workspace.style.height = `${naturalHeight}px`;
            fitImageForNewSize(containerWidth, naturalHeight);
            draw();
        };

        const fitImageForNewSize = (w, h) => {
            const scaleW = w / imgObj.width; const scaleH = h / imgObj.height;
            scale = Math.min(scaleW, scaleH);
            panX = (w - imgObj.width * scale) / 2; panY = (h - imgObj.height * scale) / 2;
        };

        btnFit.onclick = setNaturalSize;
        new ResizeObserver(() => { if (Math.abs(scale - 1.0) < 0.1 && panX === 0) { setNaturalSize(); } }).observe(workspace);
        imgObj.onload = setNaturalSize;

        const toImageCoords = (clientX, clientY) => {
            const rect = canvas.getBoundingClientRect();
            return { x: (clientX - rect.left - panX) / scale, y: (clientY - rect.top - panY) / scale };
        };

        const updateCursor = (e) => {
            if (mode !== 'edit') { workspace.style.cursor = "default"; return; }
            if (isPanning) { workspace.style.cursor = "grabbing"; return; }
            if (e && e.ctrlKey) { workspace.style.cursor = "crosshair"; } 
            else { workspace.style.cursor = "grab"; }
        };

        function draw() {
            ctx2d.setTransform(1, 0, 0, 1, 0, 0); ctx2d.clearRect(0, 0, canvas.width, canvas.height);
            if (!imgObj.complete) return;
            ctx2d.setTransform(scale, 0, 0, scale, panX, panY);
            ctx2d.drawImage(imgObj, 0, 0);

            // 1. FORMAS
            const drawShape = (r, color, isStroke) => {
                const x = r.x; const y = r.y; const w = r.w; const h = r.h;
                ctx2d.fillStyle = color; ctx2d.strokeStyle = "rgba(255,255,255,0.9)"; ctx2d.lineWidth = 2 / scale;
                ctx2d.beginPath();
                if (r.type === 'circle') ctx2d.ellipse(x + w/2, y + h/2, Math.abs(w/2), Math.abs(h/2), 0, 0, 2 * Math.PI);
                else ctx2d.rect(x, y, w, h);
                if (isStroke) { ctx2d.fill(); ctx2d.stroke(); } else { ctx2d.fill(); }
                if (mode === 'edit' && r.group) { ctx2d.fillStyle = "#3498db"; ctx2d.font = `bold ${10/scale}px sans-serif`; ctx2d.fillText("🔗", x + w, y); }
            };

            // 2. TEXTO (SIEMPRE ENCIMA)
            const drawLabel = (r) => {
                if (r.label) {
                    const x = r.x; const y = r.y; const w = r.w; const h = r.h;
                    ctx2d.fillStyle = "white"; ctx2d.font = `bold ${14/scale}px sans-serif`;
                    ctx2d.textAlign = "center"; ctx2d.textBaseline = "middle"; ctx2d.strokeStyle = "black"; ctx2d.lineWidth = 3 / scale;
                    ctx2d.strokeText(r.label, x + w/2, y + h/2); ctx2d.fillText(r.label, x + w/2, y + h/2);
                }
            };

            if (mode === 'edit') {
                rects.forEach(r => drawShape(r, r.group ? "rgba(52, 152, 219, 0.4)" : "rgba(255, 60, 60, 0.4)", true));
                rects.forEach(r => drawLabel(r));
            } else {
                const activeIndices = studyGroups[currentGroupIdx] || [];
                rects.forEach((r, i) => {
                    if (activeIndices.includes(i)) {
                        if (!isRevealed) drawShape(r, "rgba(255, 165, 0, 1)", false);
                    } else { drawShape(r, "rgba(255, 60, 60, 1)", false); }
                });
                // CORRECCIÓN: Etiqueta solo si es activa Y NO está revelada
                rects.forEach((r, i) => {
                    if (activeIndices.includes(i) && !isRevealed && r.label) drawLabel(r);
                });
            }
        }

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault(); const delta = e.deltaY > 0 ? -0.1 : 0.1; const newScale = scale * (1 + delta);
            if (newScale < 0.1 || newScale > 10) return;
            const rect = canvas.getBoundingClientRect(); const mouseX = e.clientX - rect.left; const mouseY = e.clientY - rect.top;
            panX = mouseX - (mouseX - panX) * (newScale / scale); panY = mouseY - (mouseY - panY) * (newScale / scale);
            scale = newScale; draw();
        });
        canvas.addEventListener('mousedown', (e) => {
            if (mode === 'edit' && e.button === 0 && e.ctrlKey) {
                const coords = toImageCoords(e.clientX, e.clientY); startX = coords.x; startY = coords.y; isDrawing = true; return;
            }
            if (e.button === 1 || (e.button === 0 && !e.ctrlKey)) {
                isPanning = true; panStartX = e.clientX - panX; panStartY = e.clientY - panY; workspace.style.cursor = "grabbing"; e.preventDefault(); return;
            }
        });
        canvas.addEventListener('mousemove', (e) => {
            updateCursor(e);
            if (isPanning) { panX = e.clientX - panStartX; panY = e.clientY - panStartY; draw(); return; }
            if (!isDrawing || mode !== 'edit') return;
            draw(); const coords = toImageCoords(e.clientX, e.clientY); const w = coords.x - startX; const h = coords.y - startY;
            ctx2d.setTransform(scale, 0, 0, scale, panX, panY); ctx2d.fillStyle = "rgba(255, 0, 0, 0.3)"; ctx2d.strokeStyle = "white"; ctx2d.lineWidth = 1 / scale;
            ctx2d.beginPath(); if (currentShape === 'rect') ctx2d.rect(startX, startY, w, h); else ctx2d.ellipse(startX + w/2, startY + h/2, Math.abs(w/2), Math.abs(h/2), 0, 0, 2 * Math.PI); ctx2d.fill(); ctx2d.stroke();
        });
        canvas.addEventListener('mouseup', (e) => {
            if (isPanning) { isPanning = false; updateCursor(e); return; }
            if (!isDrawing || mode !== 'edit') return; isDrawing = false;
            const coords = toImageCoords(e.clientX, e.clientY); const w = coords.x - startX; const h = coords.y - startY;
            if (Math.abs(w) < 5/scale && Math.abs(h) < 5/scale) { draw(); return; }
            rects.push({ x: startX, y: startY, w: w, h: h, type: currentShape, label: "", group: isGrouping ? activeGroupID : null }); draw();
        });

        window.addEventListener('keydown', (e) => { if(e.key === "Control") updateCursor(e); });
        window.addEventListener('keyup', (e) => { if(e.key === "Control") updateCursor(e); });

        canvas.addEventListener('contextmenu', (e) => {
            if (mode !== 'edit') return; e.preventDefault(); const coords = toImageCoords(e.clientX, e.clientY); const clickX = coords.x; const clickY = coords.y;
            for (let i = rects.length - 1; i >= 0; i--) {
                const r = rects[i]; const x1 = Math.min(r.x, r.x + r.w); const x2 = Math.max(r.x, r.x + r.w); const y1 = Math.min(r.y, r.y + r.h); const y2 = Math.max(r.y, r.y + r.h);
                if (clickX >= x1 && clickX <= x2 && clickY >= y1 && clickY <= y2) {
                    const menu = new obsidian.Menu(); menu.addItem((item) => { item.setTitle("✏️ Edit").setIcon("pencil").onClick(() => { new LabelEditModal(this.app, r.label, (t) => { r.label = t; draw(); }).open(); }); });
                    if (r.group) { menu.addItem((item) => { item.setTitle("🔗 Ungroup").setIcon("link").onClick(() => { r.group = null; draw(); }); }); } else if (isGrouping) { menu.addItem((item) => { item.setTitle("🔗 Join to Group").setIcon("link").onClick(() => { r.group = activeGroupID; draw(); }); }); }
                    menu.addItem((item) => { item.setTitle("🗑️ Delete").setIcon("trash").setWarning(true).onClick(() => { rects.splice(i, 1); draw(); }); }); menu.showAtPosition({ x: e.clientX, y: e.clientY }); return;
                }
            }
        });
        btnUndo.onclick = () => { rects.pop(); draw(); }; btnSave.onclick = () => { data.rects = rects; this.updateBlockData(el, ctx, data); new obsidian.Notice("✅ Saved"); };
        btnMode.onclick = () => {
            if (mode === 'edit') {
                if(rects.length === 0) return new obsidian.Notice("Draw squares first"); mode = 'study';
                const groupsMap = {}; const noGroupIndices = []; rects.forEach((r, idx) => { if (r.group) { if (!groupsMap[r.group]) groupsMap[r.group] = []; groupsMap[r.group].push(idx); } else { noGroupIndices.push(idx); } });
                studyGroups = []; Object.values(groupsMap).forEach(indices => studyGroups.push(indices)); noGroupIndices.forEach(idx => studyGroups.push([idx]));
                if (isRandom) studyGroups.sort(() => Math.random() - 0.5); currentGroupIdx = 0; isRevealed = false;
                btnMode.innerText = "✏ Edit"; btnMode.classList.remove("primary"); [btnUndo, btnSave, btnShape, btnRandom, btnGroup, btnFit].forEach(b => b.style.display = "none"); btnReveal.style.display = "inline-block"; draw();
            } else {
                mode = 'edit'; btnMode.innerText = "▶ Study"; btnMode.classList.add("primary"); [btnUndo, btnSave, btnShape, btnRandom, btnGroup, btnFit].forEach(b => b.style.display = "inline-block"); btnReveal.style.display = "none"; btnNext.style.display = "none"; statusText.innerText = ""; draw();
            }
            updateCursor();
        };
        const reveal = () => { isRevealed = true; btnReveal.style.display = "none"; btnNext.style.display = "inline-block"; draw(); };
        const next = () => { if (currentGroupIdx < studyGroups.length - 1) { currentGroupIdx++; isRevealed = false; btnReveal.style.display = "inline-block"; btnNext.style.display = "none"; draw(); } else { new obsidian.Notice("Review complete!"); btnMode.click(); } };
        btnReveal.onclick = reveal; btnNext.onclick = next;
        container.tabIndex = 0; container.onkeydown = (e) => { if (mode === 'study') { if (e.code === 'Space') { e.preventDefault(); if(!isRevealed) reveal(); } if (e.code === 'Enter' || e.code === 'ArrowRight') { e.preventDefault(); if(isRevealed) next(); } } else { if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); btnUndo.click(); } } };
    }
};
