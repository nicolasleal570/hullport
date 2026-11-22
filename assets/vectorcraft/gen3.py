# Menu bar template icon (porthole, monochrome). Render with:
#   vectorcraft-cli run --commands icons/tray-plain.json --export tray.svg
# tray-plain is the shipped variant (assets/tray.svg, icons/tray.png at 40x40).
import json, math
def E(cx,cy,r): return {"command":"shape.ellipse","params":{"x":cx-r,"y":cy-r,"width":2*r,"height":2*r}}
def P(d): return {"command":"path.create","params":{"d":d}}
blk=[{"command":"paint.setFill","params":{"color":"#000000"}},{"command":"paint.setStroke","params":{"none":True}}]
def pf(op,ids): return {"command":"object.pathfinder."+op,"params":{"ids":ids}}
def tray(rivets):
    c=[{"command":"artboard.setProps","params":{"index":0,"x":0,"y":0,"width":1024,"height":1024}}]
    o=len(c); c+=[E(512,512,470)]+blk
    i=len(c); c+=[E(512,512,372)]+blk
    ids=["$%d.id"%o,"$%d.id"%i]
    if rivets:
        for k in range(4):
            t=math.pi/4+k*math.pi/2
            ids.append("$%d.id"%len(c)); c+=[E(round(512+421*math.cos(t),1),round(512+400*math.sin(t),1),34)]+blk
    c+=[pf("minusFront",ids)]
    s=len(c); c+=[P("M150 530 C270 470 380 590 512 530 C644 470 754 590 874 530 L874 900 L150 900 Z")]+blk
    w=len(c); c+=[E(512,512,306)]+blk
    c+=[pf("intersect",["$%d.id"%s,"$%d.id"%w])]
    return c
for k,v in {"tray-plain":tray(False),"tray-rivets":tray(True)}.items(): json.dump(v,open("icons/"+k+".json","w"))
