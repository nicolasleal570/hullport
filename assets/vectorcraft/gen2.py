# App icon (porthole). Writes vectorcraft-cli command lists; render with:
#   vectorcraft-cli run --commands icons/a1-steel-graphite.json --export icon.svg --export icon.png --scale 1
# a1-steel-graphite is the shipped variant (assets/icon.svg).
import json, math
def R(x,y,w,h,r=0): return {"command":"shape.rectangle","params":{"x":x,"y":y,"width":w,"height":h,"radius":r}}
def E(cx,cy,rx,ry=None,rot=0): ry=ry or rx; return {"command":"shape.ellipse","params":{"x":cx-rx,"y":cy-ry,"width":2*rx,"height":2*ry,"rotation":rot}}
def P(d): return {"command":"path.create","params":{"d":d}}
def fill(c): return {"command":"paint.setFill","params":{"color":c}}
def G(stops,kind="linear",angle=-90,**kw):
    g={"kind":kind,"stops":[{"offset":o,"color":c,**({"opacity":a} if a is not None else {})} for o,c,a in [(s+(None,))[:3] for s in stops]]}
    if kind!="radial" and kind!="conic": g["angle"]=angle
    g.update(kw); return {"command":"paint.setFill","params":{"gradient":g}}
nos={"command":"paint.setStroke","params":{"none":True}}
def pf(op,ids): return {"command":"object.pathfinder."+op,"params":{"ids":ids}}
STEEL=[(0,"#eef0f2"),(.12,"#9aa0a7"),(.26,"#f7f8f9"),(.40,"#878d95"),(.55,"#e3e6e9"),(.70,"#80868e"),(.86,"#f1f3f5"),(1,"#eef0f2")]
BRASS=[(0,"#f6e2ae"),(.12,"#a37a3c"),(.26,"#fcedc6"),(.40,"#8c6731"),(.55,"#ecd29a"),(.70,"#87612c"),(.86,"#f8e6b8"),(1,"#f6e2ae")]
def icon(tile,metal,bevel,rivet,sky,sea):
    c=[{"command":"artboard.setProps","params":{"index":0,"x":0,"y":0,"width":1024,"height":1024}}]
    c+=[R(100,100,824,824,185),G(tile),nos]
    # top sheen on tile
    c+=[R(100,100,824,824,185),G([(0,"#ffffff",.10),(.5,"#ffffff",0)]),nos]
    # cast shadow under ring
    c+=[E(512,548,318,318),G([(0,"#000000",.45),(.85,"#000000",.18),(1,"#000000",0)],kind="radial"),nos]
    c+=[E(512,512,300),G(metal,kind="conic"),nos]
    c+=[E(512,512,300),G([(0,"#ffffff",.35),(.45,"#ffffff",0),(1,"#000000",.25)]),nos]
    c+=[E(512,512,240),G(bevel),nos]
    c+=[E(512,512,224),G(sky),nos]
    s=len(c); c+=[P("M280 556 C380 546 444 562 512 554 C580 546 644 562 744 552 L744 760 L280 760 Z"),fill("#000000"),nos]
    k=len(c); c+=[E(512,512,224),fill("#000000"),nos, pf("intersect",["$%d.id"%s,"$%d.id"%k]),G(sea),nos]
    # sun glow near horizon
    c+=[E(570,555,130,26),G([(0,"#fff6e0",.7),(1,"#fff6e0",0)],kind="radial"),nos]
    # glass reflection
    h=len(c); c+=[E(430,420,250,150,-35),fill("#000000"),nos]
    k=len(c); c+=[E(512,512,224),fill("#000000"),nos, pf("intersect",["$%d.id"%h,"$%d.id"%k]),G([(0,"#ffffff",.38),(1,"#ffffff",0)],angle=-60),nos]
    # inner lip shadow
    c+=[{"command":"shape.ellipse","params":{"x":288,"y":288,"width":448,"height":448}},{"command":"paint.setFill","params":{"none":True}},
        {"command":"paint.setStroke","params":{"gradient":{"kind":"linear","angle":-90,"stops":[{"offset":0,"color":"#000000","opacity":.55},{"offset":1,"color":"#000000","opacity":0}]}}},
        {"command":"stroke.set","params":{"weight":10}}]
    for i in range(8):
        t=math.pi/8+i*math.pi/4; x=512+270*math.cos(t); y=512+270*math.sin(t)
        c+=[E(round(x,1),round(y+3,1),13),fill("#000000"),nos]
        c+=[E(round(x,1),round(y,1),12),G(rivet,kind="radial"),nos]
    return c
SKY=[(0,"#4f7fb3"),(.75,"#b9cfe2"),(1,"#e9eef2")]
SEA=[(0,"#2a5a80"),(.35,"#173a5a"),(1,"#081a2c")]
out={
 "a1-steel-graphite":icon([(0,"#3c3c41"),(1,"#141416")],STEEL,[(0,"#5d636b"),(1,"#d9dde1")],[(0,"#ffffff"),(1,"#6c7178")],SKY,SEA),
 "a2-steel-light":icon([(0,"#fbfbfc"),(1,"#d6d7db")],STEEL,[(0,"#5d636b"),(1,"#d9dde1")],[(0,"#ffffff"),(1,"#6c7178")],SKY,SEA),
 "a3-brass-navy":icon([(0,"#1f3350"),(1,"#0a1322")],BRASS,[(0,"#6b4e22"),(1,"#e9cf95")],[(0,"#fff4d6"),(1,"#7d5a26")],SKY,SEA),
}
for k,v in out.items(): json.dump(v,open("icons/"+k+".json","w"))
