var _projs = {},
	_projDirname = {},
	_disableProjs = {},
	path = require('path'),
	fs = require('fs'),
	mod = require('../../mod.js'),
	util = mod.util,
	notice = mod.notice,
	_conf = mod.conf,
	DRS = mod.load('DRS'),
	reloadProjConfig = require('./reloadProjConfig.js'),
	watchFileCh = mod.load('watchFileCh'),
	dataAPI = mod.load('dataAPI'),
	d2io = mod.load('i2serv').io.of('/d2'),
	mimeTag = mod.load('mimeTag'),
	Cache;			// Cache会调用许多组建，导致这些组建，都不能使用ProjConfig


setTimeout(function(){
	Cache = mod.load('Cache');
}, 0);




function ProjConfigClass(dirname, cont) {
	var root = util.parsePath(_conf.DocumentRoot+dirname+'/');
	this.root = root;				// root作为proj的key  dirname不能，因为root为绝对路径，相比于dirname更加不容易判断错误
	this.dirname = dirname;
	this.name = cont.name || 'Unnamed Project';


	this.cache = {};
	this.cacheTpl = {};			// 缓存模板解析之后的函数  不使用ejs默认的缓存函数（变量冲突，更方便地进行管理）


	var projConf = this,
		sourceMap = this.sourceMap = {},		// 对应的多个文件 每个文件又要虚拟出一个目录和名字
		watchConf = this.watchConf = {},		// 配置文件监视+Baseless文件
		sourceRoot = this.sourceRoot = util.parsePath(root + _conf.SourcePath),
		catalog = '';
	this.watchFiles = {};		// 文件监视



	this.sync = cont.sync;			// 同步目录
	if (cont.catalog && (catalog = cont.catalog.trim())) {				// url追加地址
		var catalogRoot = util.addPath(catalog, root);
		if (catalogRoot) {
			this.catalog = catalog;
			this.removeCatalog = function(file){
				return root + file.substring(catalogRoot.length);
			};
			this.inProject = function(){
				return !file.indexOf(catalogRoot);
			};
		}
	}

	// 线上资源
	if (cont.hostname) {
		this.hostname = cont.hostname.toLowerCase();
		DRS.add(this.hostname, root);
	}

	// 二级域名
	if (cont.alias) {
		this.alias = cont.alias.trim().toLowerCase();
		this.localHostname = this.alias+'.'+_conf.Domain;
		DRS.add(this.localHostname, root);
	}

	if (cont.MinCssName) {
		var MinCssNameKeys = Object.keys(cont.MinCssName);
		if (MinCssNameKeys.length) {
			this.MinCssName = cont.MinCssName;
			this.MinCssNameReg = new RegExp('(\\.|#)?('+MinCssNameKeys.join('|')+')[A-Z][\\w\\d-]+\\b', 'g');
		}
	}




	// 给配置文件添加文件监听
	if (cont.confFiles) {
		this.confFiles = cont.confFiles;
		cont.confFiles.forEach(function(confFile){
			if(!watchConf[confFile]) watchConf[confFile] = watchConfCh(confFile, projConf);
		});
	}




	// 数据文件 判断和处理方法
	// 注意：配置文件中的参数和projConf对象中的方法参数，有所不同
	if (cont.dataAPI) this.dataAPI = dataAPI(cont.dataAPI, this);



	if (cont.HTML) {
		var HTMLData = {},
			HTMLLinks = {};		// 用于d2fs.js 404等 生成连接地址

		util.eachObject(cont.HTML, function(virtualFile, fData){
			srcFile = util.parsePath(sourceRoot + fData.srcFile);			// 需要转化地址，因为这个关系到Cache的缓存
			sourceMap[virtualFile] = srcFile;

			// 处理配置的参数
			fData.srcFile = srcFile;
			fData.outFile = root+fData.localFile;
			fData.href = catalog + fData.localFile;
			projConf.initHTMLConfig(fData);
			fData.htmlVirtualFileDirname = path.dirname(virtualFile)+path.sep;			// 解析script link资源需要（转化为绝对路径）
			
			HTMLLinks[fData.href] = fData.title;
			HTMLData[virtualFile] = fData;
		});

		this.HTMLData = HTMLData;
		this.HTMLLinks = HTMLLinks;
	}


	// 文件映射
	if (cont.fileMap) {
		var convertConf = {},	// html中一个文件对应多个文件
								// 格式：原始文件的系统绝对路径 => 转化之后的HTML
			sourceLink = {},	// 访问组合文件，自动拼接内容(build)
			fileIndex = 0;
		
		util.eachObject(cont.fileMap, function(file, srcFiles){
			var basePath = path.dirname(file) + path.sep,
				mySourceLink = [];

			convertConf[file] = srcFiles.map(function(v){
				var extname = path.extname(v),
					virtualFilename = path.basename(v, extname)+'.m'+(fileIndex++)+extname,
					srcFile = util.parsePath(sourceRoot+v);			// 需要转化地址，因为这个关系到Cache的缓存

				sourceMap[basePath+virtualFilename] = srcFile;		// fileServ 地址转化
				mySourceLink.push(srcFile);									// 原始文件路径对应拼接资源

				return virtualFilename;
			});


			if (mySourceLink.length) {		// 拒绝空数组保存（可在split过程中少进行一次if判断）
				sourceLink[file] = mySourceLink;
			}
		});


		// 转化思路：先获取所有的js和css（less）路径，用一个对象保存（路径=>[整个html标签]）
		this.convertSource4HTML = function(cont, htmlVirtualFileDirname){
			var src = {},
				convertFunc = function(str, open, split, srcPath, close){
					srcPath = srcPath.trim();
					var srcFile = util.parsePath(srcPath[0] == '/' || srcPath[0] == '\\' ? root + srcPath : htmlVirtualFileDirname+srcPath);

					if (convertConf[srcFile]) {
						var dirname = path.dirname(srcPath)+'/';
						return convertConf[srcFile].map(function(virtualFilename){
							return open+dirname+virtualFilename+close;
						}).join('\n');
					}
					return str;
				};
			
			// 对于不是less css js的文件，不改变路径，直接执行spliceServer
			cont = cont.replace(mimeTag.scriptReg, convertFunc).replace(mimeTag.linkReg, convertFunc);
			return cont;
		};

		this.sourceLink = sourceLink;
	}



	// baseLess 文件
	if (cont.baseLess) {
		var baseLess = this.baseLessFile = util.parsePath(sourceRoot + cont.baseLess);

		if (util.fileExists(baseLess)) {
			this.reloadBaseLess();

			this.watchConf[baseLess] = watchFileCh(baseLess, function(){
				notice.log('BASELESS', 'update cont', baseLess);
				projConf.reloadBaseLess();
			}, function(e){
				projConf.baseLessCont = '';
				notice.warn('BASELESS', 'Base Less File '+e, baseLess);
			});
		} else {
			notice.warn('BASELESS', 'Base Less File is not exists');
		}
	}

	// 注册
	_projs[root] = this;
	_projDirname[dirname] = this;
}



ProjConfigClass.prototype = {
	// 设置默认值
	'hostname': '',
	'localHostname': '',
	'alias': '',
	'baseLessCont': '',
	'catalog': '',
	'HTMLData': {},
	'HTMLLinks': {},
	'sourceLink': {},
	'convertSource4HTML': function(cont){
		return cont;
	},
	'dataAPI': function(uri, res, req, resErrorCall){
		resErrorCall(404);
	},
	/**
	 * 移除文件路径中的catalog部分
	 * 注意：当项目设置了catalog时，也需要先运行inProject方法，再使用改方法去除catalog
	 * @param  {String} file 需要处理的文件路径
	 * @return {String}      路径处理结果
	 */
	'removeCatalog': function(file){
		return file;
	},
	/**
	 * 检查文件是否存放在项目目录下
	 * 通过catalog参数，可能导致访问的文件，并不是项目中的文件（当然，还可以检查本身就不是改目录下的文件）
	 * @param  {[String]} file 检查的文件
	 * @return {[Boolean]}     返回是否结果
	 */
	'inProject': function(file){
		return !file.indexOf(this.root);
	},
	/**
	 * 检查文件是否存放在项目的SourcePath中
	 * SourcePath中的文件被直接访问，会触发403错误
	 * @param  {[String]} file 检查的文件
	 * @return {[Boolean]}     返回是否结果
	 */
	'inSourcePath': function(file){
		return !file.indexOf(this.sourceRoot);
	},


	'initCacheAndWatch': function(file, extname, uri, drGetCont){
		var projConf = this,
			cache = Cache(file, extname, this, drGetCont);
		this.cache[file] = cache;

		if (!this.watchFiles[file]) {
			if (extname == 'html') {
				this.addPageReloadWatch(file, function(){
					delete projConf.cacheTpl[file];
					delete projConf.cache[file];
				});
			} else if (extname == 'less' || extname == 'css') {
				this.addCssReloadWatch(file, uri.pathname);
			} else {
				this.addPageReloadWatch(file, function(){
					delete projConf.cache[file];
				});
			}
		}

		return cache;
	},
	'addCssReloadWatch': function(file, pathname){
		var projConf = this;
		this.watchFiles[file] =  watchFileCh(file, function(){
			delete projConf.cache[file];
			projConf.emit('cssReload', {
				'pathname': pathname,
				'filename': path.basename(pathname)
			});
		});
	},
	'addPageReloadWatch': function(file, callback){
		var projConf = this;
		this.watchFiles[file] = watchFileCh(file, function(){
			callback();
			projConf.emit('pageReload');
		});
	},


	'reloadBaseLess': function() {
		var projConf = this,
			baseLess = this.baseLessFile;
		try {
			projConf.baseLessCont = fs.readFileSync(baseLess).toString();

			// 删除相关的缓存
			var hasUpdate = false;
			util.eachObject(projConf.cache, function(i, v){
				if (v.extname == 'less') {
					hasUpdate = true;
					delete projConf.cache[i];
				}
			});
			if (hasUpdate) projConf.emit('pageReload');

			notice.log('BASELESS', 'read file success', baseLess);
		} catch(err) {
			notice.warn('BASELESS', err, baseLess);
		}
	},
	'emit': function(eventStr, data){
		d2io.to(this.root).emit(eventStr, data);		// d2io.to 和 d2io.in 是相同的
	},


	'initHTMLConfig': function(fData) {
		fData.data = fData.data ? Object.create(fData.data) : {};		// 复制一份data，防止多个页面共用一个data数据，导致title等数据也变成共用

		if (!fData.title) fData.title = 'Unnamed File';
		fData.extJS = fData.extJS ? fData.extJS.map(function(path){return mimeTag.js(path);}).join('\n') : '';
		fData.extCSS = fData.extCSS ? fData.extCSS.map(function(path){return mimeTag.css(path);}).join('\n') : '';

		fData.blockReg = fData.block && fData.block.trim() ? new RegExp('\\b('+fData.block.trim().replace(/\s+/g, '|')+')\\b') : false;		// 在data中将block转化为正则

		fData.projConf = this;
		fData.catalog = this.catalog;

		fData.data.sys = fData;				// 设置sys，将fData赋值给ejs
		fData.data.root = fData.data;		// 设置root，作为fData.data的顶层

		return fData;
	},

	'getHTMLConfig': function(outFile){
		var fData = this.HTMLData[outFile];
		if (fData) return fData;

		notice.warn('Serv', 'block not exisist');
		return false;
	},
	'getSitePath': function(port){
		if (this.alias) {
			return '//'+this.alias+'.'+_conf.Domain+':'+port+'/';
		} else {
			return '//'+_conf.Domain+':'+port+'/'+this.dirname+'/';
		}
	},
	'destory': function(){
		util.eachObject(this.watchFiles, function(i, v){
			v.close();
		});
		util.eachObject(this.watchConf, function(i, v){
			v.close();
		});
		this.disable();
		delete _disableProjs[this.root];		// 防止下一次destroy无法执行disable方法
	},
	'clear': function(){
		this.cache = {};
		this.cacheTpl = {};
	},
	'disable': function(){
		if (_disableProjs[this.root]) return;
		_disableProjs[this.root] = this;

		delete _projs[this.root];
		delete _projDirname[this.dirname];
		if (this.localHostname) delete DRS.hostname[this.localHostname];
		if (this.hostname) delete DRS.hostname[this.hostname];
	},
	'enable': function(){
		if (!_disableProjs[this.root]) return;
		delete _disableProjs[this.root];

		_projs[this.root] = this;
		_projDirname[this.dirname] = this;
		if (this.localHostname) DRS.add(this.localHostname, this.root);
		if (this.hostname) DRS.add(this.hostname, this.root);
	}
};




function watchConfCh(file, projConf){
	var mainFile = projConf.root + _conf.MainConfigFile;

	return watchFileCh(file, function(){
		if (fs.existsSync(mainFile)) {
			reloadProjConfig(projConf.dirname, function(mainConf, dirname){
				if (mainConf) {
					projConf.destory();
					new ProjConfigClass(dirname, mainConf);
				} else {
					projConf.disable();
				}
			});
			projConf.emit('pageReload');
		} else {
			notice.warn('ProjConf', 'Proj Main Config File has removed', mainFile);
		}
	}, function(e){
		notice.warn('ProjConf', 'config File '+e, file);
	});
}


// 空白项目，用于存放没有项目遮盖的文件
var defaultProj = new ProjConfigClass('', {'alias': 'www', 'name': 'DocumentRoot Project'});
defaultProj.destory();

module.exports = {
	'defaultProj': defaultProj,
	'projs': _projs,
	'disableProjs': _disableProjs,
	'projDirname': _projDirname,
	'class': ProjConfigClass,
	'find': function(file){
		for(var i in _projs) {
			if (!file.indexOf(i)) return _projs[i];
		}
	},
	'clearCache': clearCache
};





function clearCache(){
	defaultProj.clear();
	util.eachObject(_projs, function(i, v){
		v.clear();
	});
}

