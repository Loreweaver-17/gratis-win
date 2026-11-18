// Converts assets/gratis-icon.png into a multi-resolution assets/gratis.ico
// for the Windows build. Runs on Node built-ins only (no image libraries),
// so `npm run icons:win` works on Windows 11, macOS and Linux just like
// `npm run setup:assets`. The source PNG is decoded, area-averaged down to
// each icon size, then packed as an ICO with one 32-bit BMP frame per size
// (16px through 256px). BMP frames keep every Windows consumer happy,
// including legacy GDI+ callers that cannot decode PNG-compressed frames.
import {readFile,writeFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=path.join(root,'assets','gratis-icon.png');
const destination=path.join(root,'assets','gratis.ico');
// 256 is the largest size Windows explorer renders; 0 in the ICO directory
// entry encodes it.
const SIZES=Object.freeze([16,24,32,48,64,128,256]);

// Decode a non-interlaced 8-bit PNG into RGBA pixels. Supports the color
// type Gratis ships (truecolor with alpha) plus truecolor, grayscale,
// palette and gray+alpha, expanding everything to RGBA for the resampler.
export function decodePng(data){
  const signature=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  if(!data.subarray(0,8).equals(signature))throw new Error(`${path.basename(source)} is not a PNG file.`);
  let width,height,bitDepth=255,colorType=255,interlace=0,palette=null,trns=null;
  const idat=[];
  for(let pos=8;pos+8<=data.length;){
    const length=data.readUInt32BE(pos),type=data.toString('latin1',pos+4,pos+8),body=data.subarray(pos+8,pos+8+length);
    if(type==='IHDR'){width=body.readUInt32BE(0);height=body.readUInt32BE(4);bitDepth=body[8];colorType=body[9];interlace=body[12];}
    else if(type==='PLTE')palette=body;
    else if(type==='tRNS')trns=body;
    else if(type==='IDAT')idat.push(body);
    else if(type==='IEND')break;
    pos+=12+length;
  }
  if(!width||!height)throw new Error('PNG is missing an IHDR chunk.');
  if(bitDepth!==8)throw new Error(`Unsupported PNG bit depth ${bitDepth}; expected 8.`);
  if(interlace!==0)throw new Error(`Unsupported PNG interlace mode ${interlace}; expected 0 (none).`);
  const channels={0:1,2:3,3:1,4:2,6:4}[colorType];
  if(!channels)throw new Error(`Unsupported PNG color type ${colorType}.`);
  const raw=inflateSync(Buffer.concat(idat)),stride=width*channels;
  const rows=Buffer.alloc(height*stride);let previous=Buffer.alloc(stride);
  for(let y=0;y<height;y++){
    const start=y*(stride+1),filter=raw[start],bytes=raw.subarray(start+1,start+1+stride),out=rows.subarray(y*stride,(y+1)*stride);
    for(let x=0;x<stride;x++){
      const left=x>=channels?out[x-channels]:0,up=previous[x],upLeft=x>=channels?previous[x-channels]:0;
      let predictor;
      if(filter===4){
        const p=left+up-upLeft,pa=Math.abs(p-left),pb=Math.abs(p-up),pc=Math.abs(p-upLeft);
        predictor=pa<=pb&&pa<=pc?left:pb<=pc?up:upLeft;
      }else if(filter===1)predictor=left;
      else if(filter===2)predictor=up;
      else if(filter===3)predictor=(left+up)>>1;
      else if(filter!==0)throw new Error(`Unsupported PNG row filter ${filter}.`);
      if(filter!==0)out[x]=(bytes[x]+predictor)&255;else out[x]=bytes[x];
    }
    previous=out;
  }
  const pixels=new Uint8Array(width*height*4);
  for(let i=0;i<width*height;i++){
    const from=i*channels,to=i*4;
    if(colorType===6)pixels.set(rows.subarray(from,from+4),to);
    else if(colorType===2){pixels[to]=rows[from];pixels[to+1]=rows[from+1];pixels[to+2]=rows[from+2];pixels[to+3]=255;}
    else if(colorType===4){pixels[to]=pixels[to+1]=pixels[to+2]=rows[from];pixels[to+3]=rows[from+1];}
    else if(colorType===0){pixels[to]=pixels[to+1]=pixels[to+2]=rows[from];pixels[to+3]=trns&&trns[1]===rows[from]?0:255;}
    else{const index=rows[from];pixels[to]=palette[index*3];pixels[to+1]=palette[index*3+1];pixels[to+2]=palette[index*3+2];pixels[to+3]=trns&&index<trns.length?trns[index]:255;}
  }
  return {width,height,pixels};
}

// Box-filter downscale: every target pixel is the average of the source
// rectangle it covers, which keeps small icon sizes clean when the source
// is far larger (1254px down to 16px here).
export function resize(image,width,height){
  const {width:sw,height:sh,pixels}=image,out=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++){
    const y0=Math.floor(y*sh/height),y1=Math.max(y0+1,Math.floor((y+1)*sh/height));
    for(let x=0;x<width;x++){
      const x0=Math.floor(x*sw/width),x1=Math.max(x0+1,Math.floor((x+1)*sw/width));
      let red=0,green=0,blue=0,alpha=0,count=0;
      for(let sy=y0;sy<y1;sy++)for(let sx=x0;sx<x1;sx++){
        const p=(sy*sw+sx)*4;red+=pixels[p];green+=pixels[p+1];blue+=pixels[p+2];alpha+=pixels[p+3];count++;
      }
      const o=(y*width+x)*4;
      out[o]=Math.round(red/count);out[o+1]=Math.round(green/count);out[o+2]=Math.round(blue/count);out[o+3]=Math.round(alpha/count);
    }
  }
  return {width,height,pixels:out};
}

// 32-bit bottom-up DIB with a BITMAPINFOHEADER and an empty AND mask
// (the alpha channel carries transparency) for every size.
export function encodeBmp({width,height,pixels}){
  const header=Buffer.alloc(40),stride=width*4,maskStride=Math.ceil(width/32)*4;
  header.writeUInt32LE(40,0);header.writeInt32LE(width,4);header.writeInt32LE(height*2,8);
  header.writeUInt16LE(1,12);header.writeUInt16LE(32,14);
  const body=Buffer.alloc(stride*height+maskStride*height);
  for(let y=0;y<height;y++){
    const row=(height-1-y)*stride;
    for(let x=0;x<width;x++){
      const from=(y*width+x)*4,to=row+x*4;
      body[to]=pixels[from+2];body[to+1]=pixels[from+1];body[to+2]=pixels[from];body[to+3]=pixels[from+3];
    }
  }
  return Buffer.concat([header,body]);
}

export function encodeIco(images){
  const directory=Buffer.alloc(6+16*images.length);
  directory.writeUInt16LE(0,0);directory.writeUInt16LE(1,2);directory.writeUInt16LE(images.length,4);
  let offset=directory.length;
  images.forEach((image,index)=>{
    const entry=directory.subarray(6+16*index,22+16*index);
    entry[0]=image.size>=256?0:image.size;entry[1]=image.size>=256?0:image.size;
    entry[2]=0;entry[3]=0;entry.writeUInt16LE(1,4);entry.writeUInt16LE(32,6);
    entry.writeUInt32LE(image.data.length,8);entry.writeUInt32LE(offset,12);
    offset+=image.data.length;
  });
  return Buffer.concat([directory,...images.map(image=>image.data)]);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const decoded=decodePng(await readFile(source));
  if(decoded.width!==decoded.height)throw new Error(`Icon source must be square; ${path.relative(root,source)} is ${decoded.width}x${decoded.height}.`);
  if(decoded.width<256)throw new Error(`Icon source must be at least 256x256; ${path.relative(root,source)} is ${decoded.width}x${decoded.height}.`);
  const images=SIZES.map(size=>{const resized=resize(decoded,size,size);return {size,data:encodeBmp(resized)};});
  await writeFile(destination,encodeIco(images));
  console.log(`Wrote ${path.relative(root,destination)} with ${SIZES.length} sizes (${SIZES.join(', ')}px) from ${path.relative(root,source)}.`);
}
