"use strict";
(() => {
  const snippets = new Map();
  const bytes = new TextEncoder();
  const XML = '<?xml version="1.0" encoding="UTF-8"?>';
  const PAGE = "http://www.w3.org/1999/xhtml";
  const READABLE_IMAGE = /^image\/(?:jpeg|png|gif|webp|svg\+xml)$/i;
  const IMAGE_LIMIT = 16 * 1024 * 1024;
  const MAX_ZIP32 = 0xfffffffe;
  const FILE_AREAS = new Set(["content", "intro", "introattachment", "chapter", "page_contents", "page_answers",
    "package", "resource", "file", "files"]);
  const BLOCKS = new Set(["p","div","section","article","header","footer","main","aside","h1","h2","h3","h4","h5","h6",
    "ul","ol","li","dl","dt","dd","blockquote","pre","figure","figcaption","table","thead","tbody","tfoot",
    "tr","td","th","caption"]);
  const SUPPORTED_TAGS = new Set([...BLOCKS,"a","b","strong","i","em","span","code","s","del","sub","sup","br","hr",
    "img","audio","video","source","mark","abbr","details","summary"]);

  function xml(value) {
    return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&apos;"})[c]);
  }

  function slug(value, fallback = "curso") {
    return fold(value).replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,96) || fallback;
  }

  class ExportMedia {
    constructor(source,site) {
      this.source=source;
      this.site=site;
      this.entries=new Map();
      this.byPath=new Map();
    }
    add(file) {
      const mime=fileMime(file.filename,file.mime);
      if(!this.site && !READABLE_IMAGE.test(mime)) return null;
      const key=file.hash || file.archivePath;
      if(this.entries.has(key)) return this.entries.get(key);
      const match=/\.([a-z\d]{1,12})$/i.exec(file.filename);
      const filename=slug(match ? file.filename.slice(0,match.index) : file.filename,"arquivo");
      const path="assets/midia/"+(this.entries.size+1)+"-"+filename+(match ? "."+match[1].toLowerCase() : "");
      const entry={path,mime,file,read:()=>poolFile(this.source.archive,file,this.site ? Infinity : IMAGE_LIMIT)};
      this.entries.set(key,entry);
      this.byPath.set(path,entry);
      return entry;
    }
    addInline(reference) {
      const found=/^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=]+)$/i.exec(reference);
      if(!found || found[2].length>6_000_000) return null;
      const key=reference;
      if(this.entries.has(key)) return this.entries.get(key);
      const mime=found[1].toLowerCase(), format=mime.split("/")[1];
      const path="assets/midia/"+(this.entries.size+1)+"-imagem."+format;
      const entry={path,mime,file:{filename:"Imagem incorporada"},read:async()=>{
        const content=Uint8Array.from(atob(found[2]), char=>char.charCodeAt(0));
        return new Blob([content],{type:mime});
      }};
      this.entries.set(key,entry);
      this.byPath.set(path,entry);
      return entry;
    }
  }

  function internalRoute(reference,routes) {
    const encoded=/^\$@[A-Z_]+(?:VIEW|INDEX)BYID\*(\d+)@\$/i.exec(reference);
    const original=/\/mod\/[a-z_]+\/view\.php\?[^#]*\bid=(\d+)/i.exec(reference);
    return routes.get(encoded?.[1] || original?.[1]) || "";
  }

  function cleanMarkup(raw,format,files,media,routes,area="",item="") {
    if(!raw.trim()) return document.createDocumentFragment();
    if(["2","4"].includes(format)) {
      const fragment=document.createDocumentFragment();
      raw.split(/\r?\n\s*\r?\n/).filter(line=>line.trim()).forEach(line=>fragment.append(element("p",line)));
      return fragment;
    }
    const tpl=document.createElement("template");
    tpl.innerHTML=raw;
    const references=mediaReferences(tpl.content);
    tpl.content.querySelectorAll("script,style,link,meta,base,object,embed,svg,math,template").forEach(node=>node.remove());
    for(const frame of tpl.content.querySelectorAll("iframe")) {
      const link=external(frame.getAttribute("src"));
      const replacement=element("p");
      if(link) {
        const anchor=element("a",frame.getAttribute("title") || "Abrir conteúdo externo");
        anchor.setAttribute("href",link);
        replacement.append(anchor);
      }
      frame.replaceWith(replacement);
    }
    for(const node of [...tpl.content.querySelectorAll("*")]) {
      const tag=node.localName;
      if(!SUPPORTED_TAGS.has(tag)) {
        node.replaceWith(...node.childNodes);
        continue;
      }
      const attrs=Object.fromEntries([...node.attributes].map(a=>[a.name,a.value]));
      for(const attr of [...node.attributes]) node.removeAttribute(attr.name);
      if(attrs.id && /^[\w:.-]{1,140}$/.test(attrs.id)) node.id=attrs.id;
      if(attrs.lang && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(attrs.lang)) node.lang=attrs.lang;
      if(["td","th"].includes(tag)) {
        for(const field of ["colspan","rowspan"])
          if(/^\d{1,2}$/.test(attrs[field] || "") && Number(attrs[field])>1) node.setAttribute(field,attrs[field]);
        if(tag==="th") node.setAttribute("scope",attrs.scope==="row"?"row":"col");
      }
      if(tag==="a") {
        const ref=attrs.href || "";
        const local=linkedFile(media.source,ref,files,area,item);
        const asset=local && media.site ? media.add(local) : null;
        const href=asset?.path || (!local && (internalRoute(ref,routes) || external(ref) ||
          (/^#[\w:.-]+$/.test(ref) ? ref : "")));
        if(href) node.setAttribute("href",href);
        if(asset) node.setAttribute("download",local.filename);
      }
      if(["img","video","audio","source"].includes(tag)) {
        const ref=attrs.src || "";
        const local=linkedFile(media.source,ref,files,area,item);
        const asset=local ? media.add(local) : tag==="img" ? media.addInline(ref) : null;
        if(tag==="img") {
          if(asset && READABLE_IMAGE.test(asset.mime)) {
            node.setAttribute("src",asset.path);
            node.setAttribute("alt",attrs.alt || "");
          } else {
            const url=external(ref);
            const anchor=url ? element("a",attrs.alt || "Abrir imagem externa") : null;
            if(anchor) anchor.href=url;
            node.replaceWith(anchor || document.createTextNode(attrs.alt || ""));
          }
        } else if(media.site && (asset || !ref)) {
          if(asset) node.setAttribute("src",asset.path);
          if(tag!=="source") {
            node.setAttribute("controls","");
            node.setAttribute("preload","metadata");
          } else if(asset) node.setAttribute("type",asset.mime);
        } else {
          const url=external(ref);
          const replacement=url ? element("a","Abrir mídia externa") : document.createTextNode("");
          if(url) replacement.href=url;
          node.replaceWith(replacement);
        }
      }
    }
    const rendered=new Set();
    for(const {reference,name} of references) {
      const local=linkedFile(media.source,reference,files,area,item);
      const mime=local && fileMime(local.filename,local.mime);
      if(media.site && local && /^(video|audio)\//.test(mime) && !["video","audio","source"].includes(name)) {
        const asset=media.add(local);
        if(rendered.has(asset.path)) continue;
        rendered.add(asset.path);
        tpl.content.append(embeddedPlayer({kind:mime.split("/")[0],src:asset.path,title:local.filename}));
      } else if(!local) {
        const spec=embedSpec(reference);
        if(!spec || rendered.has(spec.src)) continue;
        rendered.add(spec.src);
        if(media.site) tpl.content.append(embeddedPlayer(spec));
        else if(name!=="a") {
          const link=element("a",spec.title);
          link.href=spec.href;
          const p=element("p");
          p.append(link);
          tpl.content.append(p);
        }
      }
    }
    return tpl.content;
  }

  function authoredFiles(source,type,data,files) {
    if(source.legacyFiles) return legacyAttachments(data,files,source.legacyId,false);
    return files.filter(file=>FILE_AREAS.has(file.area) &&
      (type==="scorm" ? file.area==="package" : type==="forum" ? ["intro","introattachment"].includes(file.area) : true));
  }

  async function exportQuestions(body,data,source,media,routes) {
    const questions=await quizRows(data,source);
    if(!questions.length) return;
    body.append(element("h3","Questões"));
    for(const {order,row} of questions) {
      const q=row?.question;
      body.append(element("h4","Questão "+order));
      if(!q) {
        body.append(element("p","Enunciado disponível no banco de questões do Moodle."));
        continue;
      }
      const files=source.records.get(row?.context) || source.legacyFiles || [];
      body.append(cleanMarkup(questionMarkup(q,source),direct(q,"questiontextformat"),files,media,routes,"questiontext",recordId(q)));
      const answers=q.querySelectorAll("answers > answer, question_answers > question_answer");
      if(answers.length && ["multichoice","truefalse"].includes(direct(q,"qtype"))) {
        const list=element("ol");
        for(const answer of answers) {
          const row=element("li");
          const text=direct(answer,"answertext") || direct(answer,"answer_text") || direct(answer,"answer");
          row.append(cleanMarkup(text,direct(answer,"answerformat"),files,media,routes,"answer",recordId(answer)));
          list.append(row);
        }
        body.append(list);
      }
    }
  }

  async function exportActivity(body,data,activity,files,media,routes) {
    const source=media.source;
    const {type}=activity;
    if(!source.legacyFiles) files=files.filter(file=>FILE_AREAS.has(file.area) &&
      (type!=="forum" || ["intro","introattachment"].includes(file.area)));
    const intro=direct(data,"intro") || direct(data,"description") || (source.legacyFiles
      ? direct(data,type==="label"?"content":"summary") : "");
    body.append(cleanMarkup(intro,direct(data,"introformat"),files,media,routes,"intro"));
    const addBlock=(owner,field,format,area,item="")=>{
      body.append(cleanMarkup(direct(owner,field),direct(owner,format),files,media,routes,area,item));
    };
    if(type==="page") addBlock(data,"content","contentformat","content");
    else if(type==="resource") addBlock(data,"alltext","format","content");
    else if(type==="assign") addBlock(data,"activity","activityformat","activity");
    else if(type==="choice") {
      const options=data.querySelectorAll("options > option");
      const list=element("ul");
      for(const option of options) list.append(element("li",direct(option,"text")));
      if(list.childElementCount) body.append(list);
    } else if(type==="url") {
      const link=external(direct(data,"externalurl"));
      if(link) {
        const anchor=element("a",link);
        anchor.href=link;
        const p=element("p");
        p.append(anchor);
        body.append(p);
        const spec=embedSpec(link);
        if(media.site && spec) body.append(embeddedPlayer(spec));
      }
    } else if(type==="book" || type==="lesson") {
      const prefix="atividade-"+slug(activity.id)+"-passo-";
      const parts=type==="book" ? data.querySelectorAll("chapters > chapter") : data.querySelectorAll("pages > page");
      for(const [idx,part] of [...parts].entries()) {
        if(direct(part,"hidden")==="1") continue;
        const title=element("h3",direct(part,"title") || (type==="book"?"Capítulo ":"Página ")+(idx+1));
        title.id=prefix+slug(recordId(part) || String(idx+1));
        body.append(title);
        if(type==="book") addBlock(part,"content","contentformat","chapter",recordId(part));
        else {
          addBlock(part,"contents","contentsformat","page_contents",recordId(part));
          const options=element("ul");
          for(const answer of part.querySelectorAll("answers > answer")) {
            const label=plain(direct(answer,"answer_text"));
            if(!label) continue;
            const row=element("li",label);
            const jump=direct(answer,"jumpto");
            const target=jump==="-1"?direct(part,"nextpageid"):jump;
            if(Number(target)>0 && [...parts].some(page=>recordId(page)===target)) {
              const anchor=element("a",label);
              anchor.setAttribute("href","#"+prefix+slug(target));
              row.replaceChildren(anchor);
            }
            options.append(row);
          }
          if(options.childElementCount) body.append(options);
        }
      }
    } else if(type==="quiz") await exportQuestions(body,data,source,media,routes);
    else if(!["label","forum","folder","scorm"].includes(type)) {
      const field=direct(data,"content") ? "content" : "summary";
      if(direct(data,field)!==intro) addBlock(data,field,field+"format","content");
    }

    const attachments=authoredFiles(source,type,data,files);
    const names=new Set();
    const list=element("ul");
    for(const file of attachments) {
      if(names.has(file.filename)) continue;
      // Embedded media is already linked to its place in the text.
      if(media.site && [...body.querySelectorAll("[src]")].some(node=>media.byPath.get(node.getAttribute("src"))?.file===file))
        continue;
      const row=element("li",file.filename);
      if(media.site) {
        const asset=media.add(file);
        const anchor=element("a",file.filename);
        anchor.setAttribute("href",asset.path);
        anchor.setAttribute("download",file.filename);
        row.replaceChildren(anchor);
        if(/^(audio|video)\//.test(asset.mime)) {
          row.append(embeddedPlayer({kind:asset.mime.split("/")[0],src:asset.path,title:file.filename}));
        }
      }
      list.append(row);
      names.add(file.filename);
    }
    const reference=external(direct(data,"reference"));
    if(type==="resource" && reference && !linkedFile(source,reference,files)) {
      const anchor=element("a","Abrir recurso externo");
      anchor.href=reference;
      const p=element("p");
      p.append(anchor);
      body.append(p);
      const spec=embedSpec(reference);
      if(media.site && spec) body.append(embeddedPlayer(spec));
    }
    if(list.childElementCount) body.append(element("h3","Arquivos da atividade"),list);
  }

  async function collect(source,site,report) {
    const sections=source.sectors.filter(section=>!section.hidden).map((section,index)=>({
      id:section.id,title:section.title,path:"topico-"+(index+1)+".html",content:section,activities:[]
    }));
    const routes=new Map();
    const sourceFiles=source.legacyFiles || (source.records.get(source.context) || [])
      .filter(file=>["summary","overviewfiles","section"].includes(file.area));
    const media=new ExportMedia(source,site);
    for(const section of sections) {
      report("Lendo "+section.title+"…");
      for(const activity of section.content.items) {
        const info=await readActivity(source,activity);
        if(info.hidden) continue;
        const anchor="atividade-"+slug(activity.id);
        routes.set(activity.id,(site ? section.path : section.path.replace(".html",".xhtml"))+"#"+anchor);
        section.activities.push({activity,anchor,...info});
      }
    }
    const intro=element("div");
    intro.append(cleanMarkup(source.summary,source.format,sourceFiles,media,routes,"summary"));
    for(const section of sections) {
      report("Preparando "+section.title+"…");
      section.summary=element("div");
      section.summary.append(cleanMarkup(section.content.summary,section.content.format,sourceFiles,media,routes,"summary",section.id));
      for(const entry of section.activities) {
        entry.body=element("div");
        if(entry.data) await exportActivity(entry.body,entry.data,entry.activity,entry.files,media,routes);
        else entry.body.append(element("p","Este item não inclui conteúdo no backup."));
      }
    }
    return {source,title:source.title,sections,intro,media,routes};
  }

  const crcTable=Uint32Array.from({length:256},(_,n)=>{
    for(let bit=0;bit<8;bit++) n=(n&1 ? 0xedb88320 : 0)^(n>>>1);
    return n>>>0;
  });
  async function crc32(blob) {
    let crc=0xffffffff;
    const reader=blob.stream().getReader();
    try {
      while(true) {
        const {value,done}=await reader.read();
        if(done) break;
        for(let index=0;index<value.length;index++) crc=crcTable[(crc^value[index])&255]^(crc>>>8);
      }
    } finally { reader.releaseLock(); }
    return (crc^0xffffffff)>>>0;
  }

  class StoredZip {
    constructor(writer=null) {
      this.writer=writer;
      this.parts=[];
      this.directory=[];
      this.offset=0;
    }
    async write(chunk) {
      if(this.writer) await this.writer.write(chunk);
      else this.parts.push(chunk);
      this.offset+=chunk instanceof Blob ? chunk.size : chunk.byteLength;
    }
    async add(name,value) {
      if(!safePath(name)) throw Error("Nome inválido no pacote exportado.");
      const filename=bytes.encode(name);
      const blob=value instanceof Blob ? value : new Blob([value]);
      const offset=this.offset;
      if(blob.size+offset+filename.length+30>MAX_ZIP32 || this.directory.length>=65534)
        throw Error("O pacote exportado excede o limite de 4 GB ou de arquivos do ZIP.");
      const crc=await crc32(blob);
      const now=new Date();
      const date=((Math.max(1980,now.getFullYear())-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
      const time=(now.getHours()<<11)|(now.getMinutes()<<5)|Math.floor(now.getSeconds()/2);
      const header=new Uint8Array(30+filename.length);
      const view=new DataView(header.buffer);
      view.setUint32(0,0x04034b50,true);
      view.setUint16(4,20,true);
      view.setUint16(6,0x0800,true);
      view.setUint16(10,time,true);
      view.setUint16(12,date,true);
      view.setUint32(14,crc,true);
      view.setUint32(18,blob.size,true);
      view.setUint32(22,blob.size,true);
      view.setUint16(26,filename.length,true);
      header.set(filename,30);
      await this.write(header);
      await this.write(blob);

      const central=new Uint8Array(46+filename.length);
      const directory=new DataView(central.buffer);
      directory.setUint32(0,0x02014b50,true);
      directory.setUint16(4,20,true);
      central.set(header.subarray(4,30),6);
      directory.setUint32(42,offset,true);
      central.set(filename,46);
      this.directory.push(central);
    }
    async finish(mime="application/zip") {
      const start=this.offset;
      const centralSize=this.directory.reduce((size,entry)=>size+entry.length,0);
      if(start+centralSize+22>MAX_ZIP32) throw Error("O pacote exportado excede o limite de 4 GB do ZIP.");
      for(const entry of this.directory) await this.write(entry);
      const end=new Uint8Array(22);
      const view=new DataView(end.buffer);
      view.setUint32(0,0x06054b50,true);
      view.setUint16(8,this.directory.length,true);
      view.setUint16(10,this.directory.length,true);
      view.setUint32(12,centralSize,true);
      view.setUint32(16,start,true);
      await this.write(end);
      if(this.writer) {
        await this.writer.close();
        return null;
      }
      return new Blob(this.parts,{type:mime});
    }
    async abort() {
      if(this.writer) await this.writer.abort().catch(()=>{});
      this.parts.length=0;
    }
  }

  function unresolved(root,missing) {
    for(const node of root.querySelectorAll("[src],[href]")) {
      const attribute=node.hasAttribute("src") ? "src" : "href";
      if(!missing.has(node.getAttribute(attribute))) continue;
      if(node.localName==="img") node.replaceWith(document.createTextNode(node.getAttribute("alt") || ""));
      else node.removeAttribute(attribute);
    }
  }

  async function fillMedia(zip,book,prefix,report) {
    const missing=new Map();
    const found=[];
    const assets=[...book.media.entries.values()];
    for(let index=0;index<assets.length;index++) {
      report("Incluindo arquivos "+(index+1)+" de "+assets.length+"…");
      const entry=assets[index];
      let data;
      try { data=await entry.read(); }
      catch(error) { missing.set(entry.path,entry.file.filename+" — "+error.message); }
      if(!data) {
        if(!missing.has(entry.path)) missing.set(entry.path,entry.file.filename+" — arquivo ausente no backup.");
        continue;
      }
      await zip.add(prefix+entry.path,data);
      found.push(entry);
    }
    const pieces=[book.intro,...book.sections.flatMap(section=>[section.summary,...section.activities.map(entry=>entry.body)])];
    if(missing.size) for(const root of pieces) unresolved(root,missing);
    return {found,missing};
  }

  const siteCss=`*{box-sizing:border-box}
body{margin:0;background:#eef6fa;color:#19232c;font:1rem/1.65 system-ui,sans-serif;overflow-wrap:anywhere}
header{background:#1877a6;color:white;padding:1.5rem max(1rem,calc((100% - 1160px)/2));border-bottom:4px solid #27aeb8}
header a{color:white}header p{margin:.1rem 0 .55rem}h1,h2,h3{line-height:1.26}
h1{font-size:clamp(1.5rem,4.5vw,2.5rem);margin:0}
main{margin:1.4rem auto;max-width:1160px;padding:0 1rem}
article,.course-panel{background:white;border:1px solid #d4e0ea;border-radius:12px;padding:clamp(1rem,3vw,2rem);margin:1rem 0}
article h2:first-child,.course-panel h2:first-child{margin-top:0}
a{color:#105879;text-underline-offset:.16em}
nav ul{list-style:none;padding:0;margin:0}nav li{padding:.55rem 0;border-bottom:1px solid #d4e0ea}
.next{display:flex;gap:1rem;flex-wrap:wrap;margin:1.4rem 0}
img,video,audio,iframe,table{max-width:100%}img{height:auto}
.embedded-media{max-width:780px;margin:1rem 0}
.embedded-media iframe,.embedded-media video{width:100%;height:auto;aspect-ratio:16/9;border:0;border-radius:8px;background:#102030}
.embedded-media audio{width:100%}
.embedded-media a{display:block;font-size:.9rem}
table{border-collapse:collapse;display:block;overflow:auto}
td,th{padding:.35rem .55rem;border:1px solid #d4e0ea;text-align:left}
pre{white-space:pre-wrap}summary{color:#105879;font-weight:650;cursor:pointer}
iframe{width:100%;height:650px;border:1px solid #d4e0ea;margin-top:.65rem;background:white}
details:not([open]) iframe{display:none}`;

  function sitePage(title,bookTitle,html,home=false) {
    const csp="default-src 'none'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; media-src 'self' data: https:; "+
      "frame-src about: https://www.youtube-nocookie.com https://player.vimeo.com; script-src 'unsafe-inline' data:; "+
      "font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'";
    return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">'+
      '<meta name="viewport" content="width=device-width, initial-scale=1">'+
      '<meta http-equiv="Content-Security-Policy" content="'+csp+'">'+
      '<title>'+xml(title)+'</title><link rel="stylesheet" href="./assets/curso.css"></head>'+
      '<body><header>'+(home?"":'<p><a href="./index.html">'+xml(bookTitle)+'</a></p>')+
      '<h1>'+xml(title)+'</h1></header><main>'+html+'</main></body></html>';
  }

  async function scormFrame(entry,source) {
    if(entry.activity.type!=="scorm" || !entry.data) return "";
    const asset=scormAssets(entry.data,entry.files,source);
    if(!asset) return "";
    const data=entry.data;
    const scos=[...data.querySelectorAll("scoes > sco")].filter(sco=>direct(sco,"launch"));
    let launch=direct(scos.find(sco=>recordId(sco)===direct(data,"launch")),"launch") || direct(scos[0],"launch");
    if(!launch) {
      const blob=await asset("imsmanifest.xml");
      if(blob) launch=manifestLaunches(new DOMParser().parseFromString(await blob.text(),"application/xml"))[0]?.path;
    }
    const location=safePath(decodedPath((launch || "index.html").split(/[?#]/,1)[0]));
    const page=location && await asset(location);
    if(!page || !/\.html?$/i.test(location)) return "";
    const isolated=await createScormDocument(await page.text(), location, asset, crypto.randomUUID());
    return '<details><summary>Testar SCORM</summary><iframe loading="lazy" sandbox="allow-scripts" '+
      'title="Atividade SCORM" srcdoc="'+xml(isolated)+'"></iframe></details>';
  }

  async function siteZip(book,zip,report) {
    const {missing}=await fillMedia(zip,book,"",report);
    const contents=new Map();
    for(const [index,section] of book.sections.entries()) {
      report("Montando a página "+(index+1)+" de "+book.sections.length+"…");
      let html='<div class="course-panel">'+section.summary.innerHTML;
      if(section.activities.length) html+='<nav aria-label="Atividades"><ul>'+section.activities.map(entry=>
        '<li><a href="#'+entry.anchor+'">'+xml(entry.activity.title)+'</a></li>').join("")+'</ul></nav>';
      html+='</div>';
      for(const entry of section.activities) {
        let player="";
        try { player=await scormFrame(entry,book.source); }
        catch {}
        html+='<article id="'+entry.anchor+'"><h2>'+xml(entry.activity.title)+'</h2>'+entry.body.innerHTML+player+'</article>';
      }
      const previous=book.sections[index-1],next=book.sections[index+1];
      html+='<nav class="next" aria-label="Tópicos"><a href="./index.html">Início do curso</a>'+
        (previous?'<a href="'+previous.path+'">Tópico anterior</a>':"")+
        (next?'<a href="'+next.path+'">Próximo tópico</a>':"")+'</nav>';
      contents.set(section.path,sitePage(section.title,book.title,html));
    }
    const index='<div class="course-panel">'+book.intro.innerHTML+'<h2>Tópicos</h2>'+
      '<nav aria-label="Tópicos do curso"><ul>'+book.sections.map(section=>
        '<li><a href="'+section.path+'">'+xml(section.title)+'</a></li>').join("")+'</ul></nav></div>';
    await zip.add("index.html",sitePage(book.title,book.title,index,true));
    for(const [path,html] of contents) await zip.add(path,html);
    await zip.add("assets/curso.css",siteCss);
    await zip.add(".nojekyll","");
    const guide="# Publicar o curso\n\n"+
      "Extraia o ZIP e abra o index.html para conferir o curso.\n\n"+
      "No GitHub, envie o conteúdo extraído para a raiz do repositório, incluindo a pasta assets e o arquivo .nojekyll. "+
      "Em Settings → Pages, escolha Deploy from a branch e selecione a branch que contém o index.html.\n\n"+
      "A versão estática inclui materiais e atividades visíveis no backup. Envios, discussões e notas dos alunos ficam fora. "+
      "Acesso, avaliação automática e registros de participação dependem de uma instalação Moodle. "+
      "Links externos ainda dependem da disponibilidade e das permissões dos serviços de origem.\n\n"+
      "O GitHub limita o tamanho de arquivos e do site publicado. Para cursos que excedam esses limites, use outra hospedagem estática.\n"+
      (missing.size ? "\n## Arquivos que não puderam ser incluídos\n\n"+[...missing.values()].map(name=>"- "+name).join("\n")+"\n" : "");
    await zip.add("PUBLICAR.md",guide);
    return {blob:await zip.finish(),missing:missing.size};
  }

  const serializer=new XMLSerializer();
  function xhtmlBody(root) { return [...root.childNodes].map(node=>serializer.serializeToString(node)).join(""); }
  function xhtml(title,body) {
    return XML+'<html xmlns="'+PAGE+'" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="pt-BR"><head>'+
      '<title>'+xml(title)+'</title><link rel="stylesheet" href="livro.css"/></head><body>'+body+'</body></html>';
  }
  async function epub(book,report) {
    const zip=new StoredZip();
    await zip.add("mimetype","application/epub+zip");
    await zip.add("META-INF/container.xml",XML+'<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'+
      '<rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    const {found,missing}=await fillMedia(zip,book,"EPUB/",report);
    const pages=book.sections.map((section,index)=>({section,id:"sec-"+(index+1),path:section.path.replace(".html",".xhtml")}));
    const nav='<nav epub:type="toc" id="toc"><h1>Sumário</h1><ol><li><a href="inicio.xhtml">Introdução</a></li>'+
      pages.map(({path,section})=>'<li><a href="'+path+'">'+xml(section.title)+'</a></li>').join("")+'</ol></nav>';
    await zip.add("EPUB/nav.xhtml",xhtml("Sumário",nav));
    await zip.add("EPUB/inicio.xhtml",xhtml(book.title,"<h1>"+xml(book.title)+"</h1>"+xhtmlBody(book.intro)));
    for(const {path,section} of pages) {
      const html="<h1>"+xml(section.title)+"</h1>"+xhtmlBody(section.summary)+section.activities.map(entry=>
        '<section id="'+entry.anchor+'"><h2>'+xml(entry.activity.title)+'</h2>'+xhtmlBody(entry.body)+'</section>').join("");
      await zip.add("EPUB/"+path,xhtml(section.title,html));
    }
    await zip.add("EPUB/livro.css","body{line-height:1.55} h1,h2,h3{line-height:1.2} img,table{max-width:100%} pre{white-space:pre-wrap} td,th{padding:.3em}");
    const date=new Date().toISOString().replace(/\.\d+Z$/,"Z");
    const uuid=crypto.randomUUID();
    const packageXml=XML+'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="pt-BR">'+
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:'+uuid+'</dc:identifier>'+
      '<dc:title>'+xml(book.title)+'</dc:title><dc:language>pt-BR</dc:language><meta property="dcterms:modified">'+date+'</meta></metadata>'+
      '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'+
      '<item id="start" href="inicio.xhtml" media-type="application/xhtml+xml"/>'+
      '<item id="css" href="livro.css" media-type="text/css"/>'+
      pages.map(page=>'<item id="'+page.id+'" href="'+page.path+'" media-type="application/xhtml+xml"/>').join("")+
      found.map((asset,index)=>'<item id="img-'+(index+1)+'" href="'+asset.path+'" media-type="'+xml(asset.mime)+'"/>').join("")+
      '</manifest><spine><itemref idref="start"/>'+pages.map(page=>'<itemref idref="'+page.id+'"/>').join("")+
      '</spine></package>';
    await zip.add("EPUB/package.opf",packageXml);
    return {blob:await zip.finish("application/epub+zip"),missing:missing.size};
  }

  function readingBlocks(book) {
    const out=[{kind:"title",runs:[{text:book.title}]}];
    function walk(root) {
      let pending=[];
      function flush(kind="paragraph",prefix="") {
        while(pending.length && !pending.at(-1).text.trim()) pending.pop();
        if(pending.length) out.push({kind,runs:prefix?[{text:prefix},...pending]:pending});
        pending=[];
      }
      function add(node,style={}) {
        if(node.nodeType===Node.TEXT_NODE) {
          let text=node.textContent.replace(/\s+/g," ");
          if(!pending.length) text=text.trimStart();
          if(text) pending.push({text,...style});
          return;
        }
        if(node.nodeType!==Node.ELEMENT_NODE) return;
        const tag=node.localName;
        if(tag==="img") {
          flush();
          out.push({kind:"image",path:node.getAttribute("src"),alt:node.getAttribute("alt") || ""});
          return;
        }
        if(tag==="br") { flush(); return; }
        if(tag==="pre") {
          flush();
          for(const line of node.textContent.split(/\r?\n/)) {
            if(line.trim()) out.push({kind:"paragraph",runs:[{text:line}]});
          }
          return;
        }
        if(tag==="table") {
          flush();
          const rows=[...node.querySelectorAll("tr")].filter(row=>row.closest("table")===node).map(row=>
            [...row.children].filter(cell=>["td","th"].includes(cell.localName)).
              map(cell=>({text:cell.textContent.trim().replace(/\s+/g," "),header:cell.localName==="th",
                span:Math.min(24,Number(cell.getAttribute("colspan")) || 1)})));
          if(rows.length) out.push({kind:"table",rows});
          return;
        }
        if(tag==="ul" || tag==="ol") {
          flush();
          const rows=[...node.children].filter(li=>li.localName==="li");
          for(const [index,li] of rows.entries()) {
            const marker=tag==="ol" ? (index+1)+". " : "• ";
            const start=out.length;
            for(const child of li.childNodes) add(child,style);
            flush("paragraph",out.length===start?marker:"");
            if(out.length>start && out[start].runs && !out[start].runs[0]?.text.startsWith(marker))
              out[start].runs.unshift({text:marker});
          }
          return;
        }
        const flags={...style};
        if(tag==="strong" || tag==="b") flags.bold=true;
        if(tag==="em" || tag==="i") flags.italic=true;
        if(tag==="a") flags.href=external(node.getAttribute("href")) || undefined;
        const block=BLOCKS.has(tag);
        const heading=/^h[1-6]$/.test(tag);
        if(block) flush();
        for(const child of node.childNodes) add(child,flags);
        if(block) flush(heading ? "subheading" : "paragraph");
      }
      for(const child of root.childNodes) add(child);
      flush();
    }
    walk(book.intro);
    for(const section of book.sections) {
      out.push({kind:"section",runs:[{text:section.title}]});
      walk(section.summary);
      for(const entry of section.activities) {
        out.push({kind:"activity",runs:[{text:entry.activity.title}]});
        walk(entry.body);
      }
    }
    return out;
  }

  function loadScript(path) {
    if(snippets.has(path)) return snippets.get(path);
    const promise=new Promise((resolve,reject)=>{
      const script=element("script");
      script.src=path;
      script.onload=resolve;
      script.onerror=()=>{ script.remove(); reject(Error("Não foi possível carregar os arquivos de exportação do aplicativo.")); };
      document.head.append(script);
    });
    snippets.set(path,promise);
    promise.catch(()=>snippets.delete(path));
    return promise;
  }

  async function raster(book,block) {
    const asset=book.media.byPath.get(block.path);
    if(!asset) return null;
    const data=await asset.read();
    if(!data) return null;
    const image=await createImageBitmap(new Blob([data],{type:asset.mime}));
    try {
      const scale=Math.min(1,1400/Math.max(image.width,image.height));
      const width=Math.max(1,Math.round(image.width*scale));
      const height=Math.max(1,Math.round(image.height*scale));
      const canvas=element("canvas");
      canvas.width=width;
      canvas.height=height;
      const ctx=canvas.getContext("2d");
      ctx.drawImage(image,0,0,width,height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
      return blob ? {width,height,data:new Uint8Array(await blob.arrayBuffer())} : null;
    } finally { image.close(); }
  }

  function textOf(block,withLinks=false) {
    let text=block.runs.map(run=>run.text).join("").trim();
    if(withLinks) {
      const targets=new Set(block.runs.filter(run=>run.href).map(run=>run.href));
      for(const url of targets) if(!text.includes(url)) text+="\n"+url;
    }
    return text;
  }

  async function pdf(book,report) {
    await Promise.all([loadScript("./assets/jspdf.js"),loadScript("./assets/pdf-font.js")]);
    if(!window.jspdf?.jsPDF || !window.moodlePdfFont) throw Error("Biblioteca de PDF indisponível.");
    const doc=new jspdf.jsPDF({format:"a4",unit:"pt",compress:true,putOnlyUsedFonts:true});
    doc.addFileToVFS("Roboto.ttf",window.moodlePdfFont);
    doc.addFont("Roboto.ttf","Roboto","normal");
    doc.setFont("Roboto","normal");
    doc.setProperties({title:book.title});
    const width=doc.internal.pageSize.getWidth(),height=doc.internal.pageSize.getHeight();
    const margin=48,right=width-margin*2, bottom=height-60;
    let y=margin, missing=0;
    const fontSizes={title:25,section:18,activity:14,subheading:12,paragraph:10.5};
    function ensure(size) {
      if(y+size<=bottom) return;
      doc.addPage();
      y=margin;
    }
    function write(text,kind="paragraph",links=[]) {
      if(!text) return;
      const size=fontSizes[kind],line=1.34*size;
      const before={title:0,section:16,activity:10,subheading:7,paragraph:0}[kind];
      doc.setFontSize(size);
      doc.setTextColor(kind==="section" || kind==="activity"?"#105879":"#141d26");
      const lines=doc.splitTextToSize(text,right);
      ensure(before+line*(kind==="paragraph"?1:Math.min(3,lines.length+1)));
      y+=before;
      for(const segment of lines) {
        ensure(line);
        doc.text(segment,margin,y,{baseline:"top"});
        const href=links.find(url=>segment.startsWith("http") && url.startsWith(segment));
        if(href) doc.link(margin,y,Math.min(right,doc.getTextWidth(segment)),line,{url:href});
        y+=line;
      }
      y+=kind==="title"?14:6;
    }
    const blocks=readingBlocks(book);
    for(const [index,block] of blocks.entries()) {
      if(index%25===0) report("Preparando PDF · "+(index+1)+" de "+blocks.length+"…");
      if(block.kind==="image") {
        const picture=await raster(book,block).catch(()=>null);
        if(!picture) {
          missing++;
          write(block.alt);
          continue;
        }
        const scale=Math.min(.75,right/picture.width,290/picture.height);
        const w=picture.width*scale,h=picture.height*scale;
        ensure(h+20);
        doc.addImage(picture.data,"PNG",margin,y,w,h);
        y+=h+8;
        continue;
      }
      if(block.kind==="table") {
        for(const row of block.rows) write(row.map(cell=>cell.text).join("  |  "));
      } else {
        const links=block.runs.filter(run=>run.href).map(run=>run.href);
        write(textOf(block,true),block.kind,links);
      }
    }
    const pages=doc.getNumberOfPages();
    doc.setTextColor("#43596b");
    doc.setFontSize(9);
    for(let page=1;page<=pages;page++) {
      doc.setPage(page);
      doc.text(String(page)+" / "+pages,width-margin,height-27,{align:"right"});
    }
    return {blob:doc.output("blob"),missing};
  }

  async function docx(book,report) {
    await loadScript("./assets/docx.js");
    if(!window.docx?.Packer) throw Error("Biblioteca de DOCX indisponível.");
    const {Document,Packer,Paragraph,TextRun,ExternalHyperlink,HeadingLevel,ImageRun,Table,TableRow,TableCell,WidthType}=window.docx;
    const elements=[];
    let missing=0;
    const heads={title:HeadingLevel.TITLE,section:HeadingLevel.HEADING_1,activity:HeadingLevel.HEADING_2,subheading:HeadingLevel.HEADING_3};
    function paragraph(block) {
      const children=block.runs.map(run=>{
        const child=new TextRun({text:run.text,bold:!!run.bold,italics:!!run.italic,...(run.href?{style:"Hyperlink"}:{})});
        return run.href ? new ExternalHyperlink({link:run.href,children:[child]}) : child;
      });
      return new Paragraph({heading:heads[block.kind],children,keepNext:!!heads[block.kind]});
    }
    const blocks=readingBlocks(book);
    for(const [index,block] of blocks.entries()) {
      if(index%25===0) report("Preparando DOCX · "+(index+1)+" de "+blocks.length+"…");
      if(block.kind==="image") {
        const picture=await raster(book,block).catch(()=>null);
        if(!picture) {
          missing++;
          if(block.alt) elements.push(new Paragraph(block.alt));
          continue;
        }
        const scale=Math.min(1,605/picture.width,420/picture.height);
        elements.push(new Paragraph({children:[new ImageRun({type:"png",data:picture.data,
          transformation:{width:Math.max(1,Math.round(picture.width*scale)),height:Math.max(1,Math.round(picture.height*scale))},
          altText:{title:block.alt || "Imagem",description:block.alt || "",name:"Ilustração do curso"}})]}));
      } else if(block.kind==="table") {
        if(block.rows.some(row=>row.length>8 || row.some(cell=>cell.span>8))) {
          for(const row of block.rows) elements.push(new Paragraph(row.map(cell=>cell.text).join("  |  ")));
          continue;
        }
        elements.push(new Table({width:{size:100,type:WidthType.PERCENTAGE},
          rows:block.rows.filter(row=>row.length).map((row,index)=>new TableRow({tableHeader:index===0 && row.every(cell=>cell.header),
            children:row.map(cell=>new TableCell({columnSpan:cell.span,children:[new Paragraph({
              children:[new TextRun({text:cell.text,bold:cell.header})]})]}))}))}));
      } else elements.push(paragraph(block));
    }
    const document=new Document({title:book.title,creator:"Pré-visualizador Moodle",
      styles:{default:{document:{run:{font:"Calibri",size:22,color:"19232C"},paragraph:{spacing:{after:120,line:282}}},
        title:{run:{font:"Calibri",color:"19232C",size:46,bold:true},paragraph:{spacing:{after:260}}},
        heading1:{run:{font:"Calibri",color:"105879",size:32,bold:true},paragraph:{spacing:{before:300,after:130}}},
        heading2:{run:{font:"Calibri",color:"19232C",size:26,bold:true},paragraph:{spacing:{before:240,after:110}}},
        heading3:{run:{font:"Calibri",color:"19232C",size:23,bold:true},paragraph:{spacing:{before:190,after:90}}}}},
      sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:1040,right:1050,bottom:1040,left:1050}}},
        children:elements}]});
    return {blob:await Packer.toBlob(document),missing};
  }

  const names={pdf:"PDF",docx:"DOCX",epub:"EPUB",zip:"Site do curso em ZIP"};
  let running=false;
  const outputStatus=$("exportStatus");
  const exportButton=$("exportCourse");
  function exportStatus(message,error=false) {
    outputStatus.hidden=!message;
    outputStatus.textContent=message;
    outputStatus.toggleAttribute("data-error",error);
  }
  function download(blob,name) {
    const url=URL.createObjectURL(blob);
    const anchor=element("a");
    anchor.href=url;
    anchor.download=name;
    anchor.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  exportButton.addEventListener("click",async()=>{
    const source=course;
    if(running || !source) return;
    const format=$("exportFormat").value;
    if(!Object.hasOwn(names,format)) return;
    running=true;
    exportButton.disabled=true;
    $("exportFormat").disabled=true;
    let zip=null;
    try {
      const filename=slug(source.title)+(format==="zip"?"-site":"")+"."+format;
      if(format==="zip") {
        let writer=null;
        if(typeof window.showSaveFilePicker==="function") {
          try {
            const file=await window.showSaveFilePicker({suggestedName:filename,types:[{
              description:"Site do curso em ZIP",accept:{"application/zip":[".zip"]}}]});
            writer=await file.createWritable();
          } catch(error) {
            if(error.name==="AbortError") return;
            if(error.name!=="SecurityError") throw error;
          }
        }
        zip=new StoredZip(writer);
      }
      exportStatus("Preparando "+names[format]+"…");
      const book=await collect(source,format==="zip",exportStatus);
      const result=format==="zip" ? await siteZip(book,zip,exportStatus) :
        await ({pdf,docx,epub})[format](book,exportStatus);
      if(result.blob) download(result.blob,filename);
      const omissions=result.missing ? " · "+result.missing+" arquivo(s) ou imagem(ns) indisponível(is)" : "";
      exportStatus(names[format]+" exportado"+omissions+".");
    } catch(error) {
      if(zip) await zip.abort();
      exportStatus(error.message || "Não foi possível exportar o curso.",true);
    } finally {
      running=false;
      exportButton.disabled=false;
      $("exportFormat").disabled=false;
    }
  });
})();
