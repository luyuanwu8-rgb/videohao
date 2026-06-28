/**
 * 画面风格清单 — 照搬 Storybound 13 风格(正向词 + 负向词)。
 *
 * 每个风格 = positive(风格特征词) + negative(该风格专属禁用词)。
 * 所有风格共用 COMMON_NEGATIVE(防文字/水印/畸形,通用)。
 * imageGenerate 把 positive 拼进出图 prompt、negative+COMMON_NEGATIVE 作负向。
 *
 * 健康图书赛道默认走「油画印象」(oil),禁混摄影术语防风格分裂(Storybound 原则)。
 * 词来源:Storybound bundle 逐字提取。
 */

export interface ImageStyle {
  key: string;
  label: string;
  desc: string;
  positive: string; // 风格正向特征词
  negative: string; // 该风格专属负向词(叠加在 COMMON_NEGATIVE 之上)
}

/** 通用负向词:所有风格共用,核心防画面出现文字/水印 + 畸形 */
export const COMMON_NEGATIVE =
  "低质量, 模糊, 变形, 畸形, 多余肢体, 解剖错误, 水印, 文字, 签名, 字幕, " +
  "标题文字, 海报文字, 横幅文字, 大字标题, 标语, 口号, 印刷文字, 招牌文字, 对话气泡";

export const IMAGE_STYLES: ImageStyle[] = [
  {
    key: "oil",
    label: "油画印象",
    desc: "印象派笔触·温润古意(健康赛道默认)",
    positive: "oil painting, impressionist style, visible brushstrokes, palette knife texture, impasto, warm light, painterly, 印象派油画风格, 厚涂笔触可见, 油画质感, 温润古意, 暖意盎然",
    negative: "photography, photorealistic, photo, camera, lens flare, depth of field, bokeh, film grain, HDR, 摄影, 景深, 虚化, 胶片颗粒, 卡通, 动漫, 3D渲染, 霓虹色",
  },
  {
    key: "realistic",
    label: "写实彩色",
    desc: "高细节·丰富色彩·纪实摄影",
    positive: "高细节, 丰富的色彩层次, 自然光影, 纪实摄影, 真实质感",
    negative: "卡通, 动漫, 插画, 油画, 素描, 3D渲染",
  },
  {
    key: "bw",
    label: "黑白纪实",
    desc: "黑白摄影·纪实光影·人文感",
    positive: "黑白摄影, 纪实光影, 高对比黑白, 人文纪实质感, 胶片颗粒",
    negative: "彩色, 鲜艳色彩, 卡通, 动漫, 3D渲染, 霓虹色",
  },
  {
    key: "cinematic",
    label: "现代电影",
    desc: "电影颗粒·色彩分级·宽银幕",
    positive: "电影颗粒质感, 色彩分级, 宽银幕构图, 戏剧性光影, 电影感",
    negative: "卡通, 动漫, 插画, 3D渲染, 平面设计, 扁平化",
  },
  {
    key: "epic",
    label: "古风电影",
    desc: "历史史诗·大气磅礴·古代场景",
    positive: "历史史诗氛围, 电影颗粒质感, 大气磅礴, 古代场景, 东方古韵",
    negative: "现代建筑, 玻璃幕墙, 现代服装, 汽车, 手机, 电线杆, 霓虹灯, LED灯, 卡通, 动漫, 3D渲染, 扁平设计",
  },
  {
    key: "kodak",
    label: "复古胶片",
    desc: "80年代柯达·颗粒分明·怀旧色温",
    positive: "80年代柯达胶片摄影质感, 颗粒分明, 怀旧色温, 老电影画面, 复古胶片",
    negative: "数码感, 高饱和, 卡通, 动漫, 3D渲染, 现代滤镜",
  },
  {
    key: "watercolor",
    label: "水彩治愈",
    desc: "水彩晕染·留白透气·柔和笔触",
    positive: "水彩晕染质感, 留白透气, 柔和笔触, 纸纹细节自然, 治愈氛围",
    negative: "摄影, 写实照片, 3D渲染, 浓重色彩, 油画厚涂",
  },
  {
    key: "magazine",
    label: "杂志插画",
    desc: "极简扁平·鲜明色块·几何构图",
    positive: "极简扁平插画, 杂志封面风格, 鲜明色块, 几何构图, 现代平面设计",
    negative: "写实摄影, 3D渲染, 油画厚涂, 复杂细节, 颗粒质感",
  },
  {
    key: "pixar",
    label: "皮克斯3D",
    desc: "皮克斯/迪士尼3D动画·立体光影·鲜亮",
    positive: "皮克斯迪士尼式3D动画质感, 卡通造型, 立体光影, 鲜亮色彩, 高质感角色建模, 梦幻场景",
    negative: "写实摄影, 照片写实, 油画, 水墨, 恐怖, 骷髅, 暴力, 阴森",
  },
  {
    key: "ink",
    label: "中国水墨",
    desc: "笔触苍劲·水墨晕染·东方禅意",
    positive: "中国水墨画, 笔触苍劲写意, 水墨晕染自然, 留白透气, 东方禅意",
    negative: "西方油画, 鲜艳色彩, 3D渲染, 照片写实, 卡通动漫, 霓虹色, 现代建筑",
  },
  {
    key: "gongbi",
    label: "民间故事工笔",
    desc: "工笔细线·传统叙事·古典",
    positive: "中国工笔画, 工笔细线, 传统民间故事插画, 古典叙事, 细腻设色",
    negative: "西方油画, 3D渲染, 照片写实, 卡通, 现代场景, 霓虹色",
  },
  {
    key: "ghibli",
    label: "吉卜力治愈",
    desc: "宫崎骏式·水彩天空·童话治愈",
    positive: "吉卜力宫崎骏式手绘动画, 柔和自然笔触, 丰富层次的水彩天空与植被, 童话氛围, 治愈感强",
    negative: "写实摄影, 照片写实, 3D渲染, 皮克斯风格, 鲜艳过饱和, 恐怖, 暴力, 骷髅, 赛博朋克",
  },
  {
    key: "blackboard",
    label: "黑板橙绘",
    desc: "黑板粉笔·知识带货爆款·手写感",
    positive: "黑板背景, 橙色粉笔手绘风格, 知识科普插画, 手写板书质感, 简洁示意图",
    negative: "写实摄影, 3D渲染, 油画, 鲜艳照片, 复杂背景",
  },
];

export const STYLE_KEYS = IMAGE_STYLES.map((s) => s.key);
export const DEFAULT_STYLE = "oil"; // 健康赛道默认油画印象

export function imageStyle(key: string): ImageStyle {
  return IMAGE_STYLES.find((s) => s.key === key) ?? IMAGE_STYLES[0];
}

