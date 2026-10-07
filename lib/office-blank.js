// office-blank.js - minimal, valid blank docx / xlsx / pptx files, built without dependencies
// (a deflate zip over fixed XML). The result goes through the normal upload pipeline, so it is
// held to the same type checks as any file a member uploads.

var zlib = require("zlib");
var { crc32 } = require("./skills-validator");

var NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
var NS_DOCREL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
var XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function rels(list) {
  return XML + '<Relationships xmlns="' + NS_REL + '">' + list.map(function (r, i) {
    return '<Relationship Id="rId' + (i + 1) + '" Type="' + NS_DOCREL + "/" + r[0] + '" Target="' + r[1] + '"/>';
  }).join("") + "</Relationships>";
}
function types(overrides) {
  return XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.map(function (o) { return '<Override PartName="' + o[0] + '" ContentType="' + o[1] + '"/>'; }).join("") + "</Types>";
}
var CT = "application/vnd.openxmlformats-officedocument.";

// Stored entries are deflated; names are ASCII, so no UTF-8 flag is needed.
function zip(files) {
  var locals = [], central = [], offset = 0;
  Object.keys(files).forEach(function (name) {
    var data = Buffer.from(files[name], "utf8"), packed = zlib.deflateRawSync(data), nb = Buffer.from(name), crc = crc32(data);
    var lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(packed.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, packed);
    var ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(packed.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += 30 + nb.length + packed.length;
  });
  var cd = Buffer.concat(central), end = Buffer.alloc(22), n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}

function docx() {
  var W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return zip({
    "[Content_Types].xml": types([["/word/document.xml", CT + "wordprocessingml.document.main+xml"]]),
    "_rels/.rels": rels([["officeDocument", "word/document.xml"]]),
    "word/document.xml": XML + '<w:document xmlns:w="' + W + '"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>',
  });
}

function xlsx() {
  var S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  return zip({
    "[Content_Types].xml": types([["/xl/workbook.xml", CT + "spreadsheetml.sheet.main+xml"], ["/xl/worksheets/sheet1.xml", CT + "spreadsheetml.worksheet+xml"]]),
    "_rels/.rels": rels([["officeDocument", "xl/workbook.xml"]]),
    "xl/workbook.xml": XML + '<workbook xmlns="' + S + '" xmlns:r="' + NS_DOCREL + '"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": rels([["worksheet", "worksheets/sheet1.xml"]]),
    "xl/worksheets/sheet1.xml": XML + '<worksheet xmlns="' + S + '"><sheetData/></worksheet>',
  });
}

function pptx() {
  var A = "http://schemas.openxmlformats.org/drawingml/2006/main", P = "http://schemas.openxmlformats.org/presentationml/2006/main";
  var nv = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  var ns = 'xmlns:a="' + A + '" xmlns:r="' + NS_DOCREL + '" xmlns:p="' + P + '"';
  var fill = function (n) { var s = ""; for (var i = 0; i < n; i++) s += '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'; return s; };
  var ln = function (w) { return '<a:ln w="' + w + '"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'; };
  var theme = XML + '<a:theme xmlns:a="' + A + '" name="Office"><a:themeElements>' +
    '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
    '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    '<a:fmtScheme name="Office"><a:fillStyleLst>' + fill(3) + "</a:fillStyleLst><a:lnStyleLst>" + ln(6350) + ln(12700) + ln(19050) + "</a:lnStyleLst>" +
    "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
    "<a:bgFillStyleLst>" + fill(3) + "</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>";
  return zip({
    "[Content_Types].xml": types([
      ["/ppt/presentation.xml", CT + "presentationml.presentation.main+xml"], ["/ppt/slideMasters/slideMaster1.xml", CT + "presentationml.slideMaster+xml"],
      ["/ppt/slideLayouts/slideLayout1.xml", CT + "presentationml.slideLayout+xml"], ["/ppt/slides/slide1.xml", CT + "presentationml.slide+xml"],
      ["/ppt/theme/theme1.xml", CT + "theme+xml"],
    ]),
    "_rels/.rels": rels([["officeDocument", "ppt/presentation.xml"]]),
    "ppt/presentation.xml": XML + "<p:presentation " + ns + '><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    "ppt/_rels/presentation.xml.rels": rels([["slideMaster", "slideMasters/slideMaster1.xml"], ["slide", "slides/slide1.xml"], ["theme", "theme/theme1.xml"]]),
    "ppt/slideMasters/slideMaster1.xml": XML + "<p:sldMaster " + ns + "><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg><p:spTree>" + nv + "</p:spTree></p:cSld>" +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>',
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([["slideLayout", "../slideLayouts/slideLayout1.xml"], ["theme", "../theme/theme1.xml"]]),
    "ppt/slideLayouts/slideLayout1.xml": XML + "<p:sldLayout " + ns + ' type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>' + nv + "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>",
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([["slideMaster", "../slideMasters/slideMaster1.xml"]]),
    "ppt/slides/slide1.xml": XML + "<p:sld " + ns + "><p:cSld><p:spTree>" + nv + "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
    "ppt/slides/_rels/slide1.xml.rels": rels([["slideLayout", "../slideLayouts/slideLayout1.xml"]]),
    "ppt/theme/theme1.xml": theme,
  });
}

var BUILDERS = { docx: docx, xlsx: xlsx, pptx: pptx };
var DEFAULT_NAMES = { docx: "새 문서.docx", xlsx: "새 스프레드시트.xlsx", pptx: "새 프레젠테이션.pptx" };

function buildBlank(ext) {
  if (!BUILDERS[ext]) return null;
  return BUILDERS[ext]();
}

module.exports = { buildBlank: buildBlank, DEFAULT_NAMES: DEFAULT_NAMES, TYPES: Object.keys(BUILDERS) };
