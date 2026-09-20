// UIA-less Qt surfaces still need positive main-shell evidence. These masks
// contain only the standard Contacts and menu glyphs, no user image or text.
const CONTACTS = [
  "000000000000000000000000", "000000000000000000000000", "000000000000000000000000",
  "000000000110000000000000", "000000011101100000000000", "000000010000100000000000",
  "000000010000110000000000", "000000110000110011111100", "000000010000110000000000",
  "000000011001100000000000", "000000001111100011111100", "000000000000000001111100",
  "000000000000000000000000", "000000111111110000000000", "000011111111111100011100",
  "000011100000011110011100", "001100000000000011000000", "001100000000000011100000",
  "011100000000000001100000", "001111111111111111100000", "001111111111111111000000",
  "000000000000000000000000", "000000000000000000000000", "000000000000000000000000"
];
const MENU = Array.from({ length: 24 }, (_, y) => [7, 11, 12, 16].includes(y)
  ? "000011111111111111110000" : "000000000000000000000000");

const WECHAT_MAIN_WINDOW_VISUAL_CSHARP = String.raw`
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class WechatMainWindowVisual {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  static readonly string Contacts = "${CONTACTS.join("")}";
  static readonly string Menu = "${MENU.join("")}";
  public sealed class Match {
    public double Score; public int X, Y, Size;
  }
  // Nearest-pixel sampling intentionally preserves line strokes at fractional
  // DPI. Contrast against the patch corners supports both light and dark UI.
  static double Score(byte[] data, int stride, int width, int height, int cx, int cy, int size, string mask) {
    int left = cx-size/2, top = cy-size/2;
    if (left < 0 || top < 0 || left+size >= width || top+size >= height) return 0;
    int[] bg = new int[3];
    for (int y=0; y<2; y++) for (int x=0; x<2; x++) {
      int at=(top+y*(size-1))*stride+(left+x*(size-1))*4;
      for (int c=0;c<3;c++) bg[c]+=data[at+c];
    }
    for(int c=0;c<3;c++) bg[c]/=4;
    int expected=0, observed=0, overlap=0;
    for (int y=0; y<24; y++) for (int x=0; x<24; x++) {
      int px=left+(int)((x+0.5)*size/24), py=top+(int)((y+0.5)*size/24);
      int at=py*stride+px*4;
      bool foreground=(Math.Abs(data[at]-bg[0])+Math.Abs(data[at+1]-bg[1])+Math.Abs(data[at+2]-bg[2]))>=105;
      bool wanted=mask[y*24+x]=='1';
      if(wanted) expected++; if(foreground) observed++; if(wanted&&foreground) overlap++;
    }
    return observed==0 ? 0 : 2.0*overlap/(expected+observed);
  }
  static Match Search(byte[] data,int stride,int width,int height,double scale,string mask,int x0,int x1,int y0,int y1) {
    var best=new Match();
    int minSize=Math.Max(18,(int)Math.Round(23*scale)), maxSize=(int)Math.Round(29*scale);
    for(int size=minSize;size<=maxSize;size++)
      for(int y=Math.Max(0,y0);y<Math.Min(height,y1);y++)
        for(int x=Math.Max(0,x0);x<Math.Min(width,x1);x++) {
          double score=Score(data,stride,width,height,x,y,size,mask);
          if(score>best.Score) {best.Score=score;best.X=x;best.Y=y;best.Size=size;}
        }
    return best;
  }
  public static double[] Inspect(Bitmap image,double dpi) {
    if(dpi<72||dpi>480||image.Width<600||image.Height<500) return new double[]{0,0};
    double scale=dpi/96.0;
    // Only copy the app-navigation strip; no chat pixels are inspected.
    int width=Math.Min(image.Width,(int)Math.Ceiling(78*scale)),height=image.Height;
    using(var strip=image.Clone(new Rectangle(0,0,width,height),PixelFormat.Format32bppArgb)) {
      BitmapData bits=strip.LockBits(new Rectangle(0,0,width,height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
      byte[] data;
      try {if(bits.Stride<=0)return new double[]{0,0};data=new byte[bits.Stride*height];Marshal.Copy(bits.Scan0,data,0,data.Length);}
      finally {strip.UnlockBits(bits);}
      int stride=width*4;
      var menu=Search(data,stride,width,height,scale,Menu,(int)(17*scale),(int)(55*scale),height-(int)(95*scale),height-(int)(12*scale));
      // Thin hamburger strokes lose a pixel when Windows scales to 100%.
      // They are supporting evidence; the distinct Contacts glyph stays 0.80.
      if(menu.Score<0.75)return new double[]{0,menu.Score};
      var contacts=Search(data,stride,width,height,scale,Contacts,menu.X-(int)(5*scale),menu.X+(int)(5*scale)+1,(int)(95*scale),Math.Min(height/2,(int)(245*scale)));
      if(Math.Abs(contacts.Size-menu.Size)>Math.Max(3,scale*3))return new double[]{0,menu.Score};
      return new double[]{contacts.Score,menu.Score};
    }
  }
  static bool Owned(IntPtr window,uint expected,RECT rect) {
    uint pid;GetWindowThreadProcessId(window,out pid);
    RECT current;
    return pid==expected&&GetWindowRect(window,out current)&&current.Left==rect.Left&&current.Top==rect.Top&&current.Right==rect.Right&&current.Bottom==rect.Bottom;
  }
  static bool StripVisible(IntPtr window,RECT rect,double scale) {
    if(GetForegroundWindow()!=window)return false;
    // Check the actual pixels being sampled, including any covering popup.
    for(int y=rect.Top+8;y<rect.Bottom-8;y+=8)
      for(int x=rect.Left+8;x<rect.Left+(int)(78*scale);x+=8)
        if(GetAncestor(WindowFromPoint(new POINT{X=x,Y=y}),2)!=window)return false;
    return true;
  }
  public static bool Accepted(double[] scores) {return scores[0]>=0.80&&scores[1]>=0.75;}
  public static bool Verify(IntPtr window,uint pid) {
    RECT rect;
    if(!GetWindowRect(window,out rect)||!Owned(window,pid,rect))return false;
    int width=rect.Right-rect.Left,height=rect.Bottom-rect.Top;
    uint dpi=GetDpiForWindow(window);
    if(width<600||height<500||width>10000||height>6000||dpi<72||dpi>480)return false;
    using(var image=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
      bool printed=false;
      using(var graphics=Graphics.FromImage(image)) {
        graphics.Clear(Color.Transparent);
        IntPtr dc=graphics.GetHdc();
        try {printed=PrintWindow(window,dc,2);} finally {graphics.ReleaseHdc(dc);}
      }
      if(printed&&Accepted(Inspect(image,dpi))&&Owned(window,pid,rect))return true;
      // No focus stealing. Screen fallback needs foreground plus unobscured
      // sidebar ownership both before and after capture; a user switch aborts.
      if(!StripVisible(window,rect,dpi/96.0)||!Owned(window,pid,rect))return false;
      using(var graphics=Graphics.FromImage(image)) {
        graphics.Clear(Color.Transparent);
        graphics.CopyFromScreen(rect.Left,rect.Top,0,0,new Size(Math.Min(width,(int)Math.Ceiling(78*dpi/96.0)),height));
      }
      return StripVisible(window,rect,dpi/96.0)&&Owned(window,pid,rect)&&Accepted(Inspect(image,dpi));
    }
  }
}
`;

const WECHAT_MAIN_WINDOW_VISUAL_SCRIPT = String.raw`
function Test-WechatVisualNavigation([object]$window) {
  if (-not $window.visible -or $window.minimized -or $window.toolWindow -or $window.owner -ne 0 -or
      $window.layoutRank -le 0 -or $window.windowClass -notmatch '(?i)^Qt.*QWindowIcon$' -or
      @('微信','WeChat','Weixin') -notcontains [string]$window.title) { return $false }
  try {
    if (-not ('WechatMainWindowVisual' -as [type])) {
      Add-Type -AssemblyName System.Drawing
      Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
${WECHAT_MAIN_WINDOW_VISUAL_CSHARP}
'@
    }
    return [WechatMainWindowVisual]::Verify([IntPtr]$window.hWnd,[uint32]$window.pid)
  } catch { return $false }
}
`;

module.exports = { WECHAT_MAIN_WINDOW_VISUAL_SCRIPT, WECHAT_MAIN_WINDOW_VISUAL_CSHARP };
