"""Generate Folio's original typographic icon from a local system font."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
root=Path(__file__).resolve().parent.parent
image=Image.new('RGBA',(1024,1024),(0,0,0,0))
draw=ImageDraw.Draw(image)
draw.rounded_rectangle((32,32,992,992),radius=218,fill='#485f4b')
font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Georgia Italic.ttf',910)
draw.text((492,454),'f',anchor='mm',font=font,fill='#f5f6ed',stroke_width=0)
image.save(root/'assets/icon.png')
iconset=root/'output/Folio.iconset';iconset.mkdir(parents=True,exist_ok=True)
for size in (16,32,128,256,512):
 for scale in (1,2):
  suffix='@2x' if scale==2 else ''
  image.resize((size*scale,size*scale),Image.Resampling.LANCZOS).save(iconset/f'icon_{size}x{size}{suffix}.png')
