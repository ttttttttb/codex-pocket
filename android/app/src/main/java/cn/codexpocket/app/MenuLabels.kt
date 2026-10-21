package cn.codexpocket.app

internal fun isFileSourceAction(label:String)=Regex("^(?:文件和文件夹|文件与文件夹|添加文件(?:和图片)?|Files? and folders?|Add files?(?: and photos)?)(?:$|[\\s….(（])",RegexOption.IGNORE_CASE).containsMatchIn(label.trim())
internal fun isDrawingAction(label:String)=Regex("^(?:绘图|画图|Draw|Drawing)(?:$|[\\s….(（])",RegexOption.IGNORE_CASE).containsMatchIn(label.trim())
