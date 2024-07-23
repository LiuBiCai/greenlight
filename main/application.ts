import { app as ElectronApp, BrowserWindow, dialog } from 'electron'
import * as fs from 'fs'
import serve from 'electron-serve'
import Store from 'electron-store'
import Debug from 'debug'
import { createWindow, xboxWorker, updater } from './helpers'
import Authentication from './authentication'
import Ipc from './ipc'
import WebUI from './webui'

import xboxWebApi from 'xbox-webapi'
import xCloudApi from './helpers/xcloudapi'

import pkg from '../package.json'

import { TokenStore } from 'xal-node'

interface startupFlags {
    fullscreen:boolean;
    autoStream:string;
}

export default class Application {

    private _log
    
    public _store
    public _path:string
    private _startupFlags: startupFlags = {
        fullscreen: false,
        autoStream: '',
    }
    public _consoleID:string

    public _isProduction:boolean = (process.env.NODE_ENV === 'production')
    private _isCi:boolean = (process.env.CI !== undefined)
    private _isMac:boolean = (process.platform === 'darwin')
    private _isWindows:boolean = (process.platform === 'win32')
    private _isQuitting:boolean = false

    public _mainWindow
    public _ipc:Ipc
    public _webUI:WebUI
    public _authentication:Authentication

    constructor(){
        
        console.log(__filename+'[constructor()] Starting Greenlight v'+pkg.version)
        this._log = Debug('greenlight')

        ElectronApp.commandLine.appendSwitch('enable-features', 'VaapiIgnoreDriverChecks,VaapiVideoDecoder,PlatformHEVCDecoderSupport,CanvasOopRasterization')
        // ElectronApp.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder');
        ElectronApp.commandLine.appendSwitch('enable-gpu-rasterization')
        ElectronApp.commandLine.appendSwitch('enable-oop-rasterization')
        ElectronApp.commandLine.appendSwitch('accelerated-video-decode')
        ElectronApp.commandLine.appendSwitch('ozone-platform-hint', 'x11')
        ElectronApp.commandLine.appendSwitch('ignore-gpu-blocklist')
        // ElectronApp.commandLine.appendSwitch('enable-zero-copy');
        
        this._path=this.readStartupFlags()
        this._store = new Store({ cwd: this._path })
        //this._store = new Store()

        this.loadApplicationDefaults()
        this.loadToken()
        // ElectronApp.removeAsDefaultProtocolClient('ms-xal-public-beta-000000004c20a908')
        
        this._ipc = new Ipc(this)
        this._authentication = new Authentication(this)

        this._ipc.startUp()
        this._webUI = new WebUI(this)
    }

    loadToken(){
        const store = new Store()
        const tokens = store.get('user.tokenstore', '{}') as string
        console.log('tokens:', tokens)
        if(tokens !== '{}') return
        console.log('load token')


        const tokenFilePath = process.cwd()+'/store/'+this._path
        // Check if the token file exists
        if (!fs.existsSync(tokenFilePath)) {
            console.log('Token file does not exist:', tokenFilePath)
            return// Exit the function if file does not exist
        }
    
        const tokenStore = new TokenStore()
        const token= tokenStore.load(tokenFilePath)
        console.log('token:', token)
        
        const data = JSON.stringify({
            userToken: tokenStore._userToken?.data,
            sisuToken: tokenStore._sisuToken?.data,
            jwtKeys: tokenStore._jwtKeys,
        })       
        
        store.set('user.tokenstore', data)
    }

    log(namespace = 'application', ...args){
        this._log.extend(namespace)(...args)
    }

    getStartupFlags(){
        return this._startupFlags
    }

    resetAutostream(){
        this._startupFlags.autoStream = ''
    }

    readStartupFlags(){
        this.log('application', __filename+'[readStartupFlags()] Program args detected:', process.argv)
        

        for(const arg in process.argv){
            if(process.argv[arg].includes('--fullscreen')){
                this.log('application', __filename+'[readStartupFlags()] --fullscreen switch found. Setting fullscreen to true')
                this._startupFlags.fullscreen = true            

            }

            if(process.argv[arg].includes('--connect=')){
                const key = process.argv[arg].substring(10)

                this.log('application', __filename+'[readStartupFlags()] --connect switch found. Setting autoStream to', key)
                this._startupFlags.autoStream = key
            }
            if(process.argv[arg].includes('--console=')){
                const key = process.argv[arg].substring(10)

                this.log('application', __filename+'[readStartupFlags()] --console switch found. Setting console to', key)
                this._consoleID = key
            }



            if(process.argv[arg].includes('--path=')) {
                const path = process.argv[arg].substring(7)
                
                this.log('application', __filename+'[readStartupFlags()] --path switch found. Setting path to', path)
                // this._store.set('settings.downloadPath', path)     
                //this._store = new Store({ cwd:path })
                return path
                
            }
        }

        this.log('application', __filename+'[readStartupFlags()] End result of startupFlags:', this._startupFlags)
       
    }

    loadApplicationDefaults(){
        if(this._isProduction === true && this._isCi === false) {
            
            ElectronApp.setPath('userData', `${ElectronApp.getPath('userData')} (${this._path              
            })`)
            ElectronApp.setPath('sessionData', `${ElectronApp.getPath('userData')}`)
            serve({ directory: 'app' })

        } else if(this._isCi === true) {
            //const random = Math.random()*100
            ElectronApp.setPath('userData', `${ElectronApp.getPath('userData')} (${this._path              
            })`)
            ElectronApp.setPath('sessionData', `${ElectronApp.getPath('userData')} (${this._path})`)
            this._store.delete('user')
            this._store.delete('auth')

            serve({ directory: 'app' })
        } else {
            
            ElectronApp.setPath('userData', `${ElectronApp.getPath('userData')} (development)`)
        }

        ElectronApp.whenReady().then(() => {
            updater({
                // debug: true,
                silent: true,
                prereleases: (ElectronApp.getVersion().includes('beta')) ? true : false,
            }, this)

            this.log('electron', __filename+'[loadApplicationDefaults()] Electron has been fully loaded. Ready to open windows')

            this.openMainWindow()
            this._authentication.startWebviewHooks()
        
            // Check authentication
            if(! this._authentication.checkAuthentication()){
                this._authentication.startAuthflow()
            }

        }).catch((error) => {
            this.log('electron', __filename+'[loadApplicationDefaults()] Electron has failed to load:', error)
        })
          
        ElectronApp.on('window-all-closed', () => {
            if(this._isMac === true){
                this.log('electron', __filename+'[loadApplicationDefaults()] Electron detected that all windows are closed. Running in background...')

            } else {
                this.log('electron', __filename+'[loadApplicationDefaults()] Electron detected that all windows are closed. Quitting app...')
                ElectronApp.quit()
            }
        })

        ElectronApp.on('activate', () => {
            (this._mainWindow !== undefined) ? this._mainWindow.show() : this.openMainWindow() 
        })
        ElectronApp.on('before-quit', () => this._isQuitting = true)
    }

    _webApi:xboxWebApi
    _xHomeApi:xCloudApi
    _xCloudApi:xCloudApi
    _xboxWorker:xboxWorker

    authenticationCompleted(streamingTokens, webToken){
        this.log('electron', __filename+'[authenticationCompleted()] authenticationCompleted called')
        // const tokens = this._authentication._tokens
        this._xHomeApi = new xCloudApi(this, streamingTokens.xHomeToken.getDefaultRegion().baseUri.substring(8), streamingTokens.xHomeToken.data.gsToken, 'home')

        if(streamingTokens.xCloudToken !== null){
            this._xCloudApi = new xCloudApi(this, streamingTokens.xCloudToken.getDefaultRegion().baseUri.substring(8), streamingTokens.xCloudToken.data.gsToken, 'cloud')
        }

        this._webApi = new xboxWebApi({
            userToken: webToken.data.Token,
            uhs: webToken.data.DisplayClaims.xui[0].uhs,
        })

        this._authentication._isAuthenticating = false
        this._authentication._isAuthenticated = true

        this._webApi.getProvider('profile').get('/users/me/profile/settings?settings=GameDisplayName,GameDisplayPicRaw,Gamerscore,Gamertag').then((result) => {
            if(result.profileUsers.length > 0) {
                for(const setting in result.profileUsers[0].settings){

                    if(result.profileUsers[0].settings[setting].id === 'Gamertag'){
                        this._store.set('user.gamertag', result.profileUsers[0].settings[setting].value)

                    } else if(result.profileUsers[0].settings[setting].id === 'GameDisplayPicRaw'){
                        this._store.set('user.gamerpic', result.profileUsers[0].settings[setting].value)

                    } else if(result.profileUsers[0].settings[setting].id === 'Gamerscore'){
                        this._store.set('user.gamerscore', result.profileUsers[0].settings[setting].value)
                    }
                }
            }

            // Run workers
            this._xboxWorker = new xboxWorker(this)
            this._ipc.onUserLoaded()

        }).catch((error) => {
            this.log('electron', __filename+'[authenticationCompleted()] Failed to retrieve user profile:', error)
            dialog.showMessageBox({
                message: 'Error: Failed to retrieve user profile:'+ JSON.stringify(error),
                type: 'error',
            })
        })
    }

    openMainWindow(){
        this.log('electron', __filename+'[openMainWindow()] Creating new main window')

        const windowOptions:any = {
            title: this._consoleID,
            backgroundColor: 'rgb(26, 27, 30)',
        }
        if(this._startupFlags.fullscreen === true){
            windowOptions.fullscreen = true
        }

        this._mainWindow = createWindow('main', {
            width: 1280,
            height: 800,
            ...windowOptions,
        })

        this._mainWindow.on('show', () => {
            this.log('electron', __filename+'[openMainWindow()] Showing Main window.')
        })

        this._mainWindow.on('close', (event) => {
            if(this._isMac === true && this._isQuitting === false){
                event.preventDefault()
                this.log('electron', __filename+'[openMainWindow()] Main window has been hidden')
                this._mainWindow.hide()
            } else {
                this.log('electron', __filename+'[openMainWindow()] Main window has been closed')
                this._mainWindow = undefined
            }
        })

        if (this._isProduction === true && this._isCi === false) {
            this._mainWindow.loadURL('app://./home.html')
        } else {
            const port = process.argv[2] || 3000
            this._mainWindow.loadURL(`http://localhost:${port}/home`)
            //this._mainWindow.loadURL(`http://www.baidu.com`)
            if(this._isCi !== true){
                this._mainWindow.webContents.openDevTools()
                this.openGPUWindow()
            }
        }
    }

    _gpuWindow

    openGPUWindow(){
        this._gpuWindow = new BrowserWindow({
            width: 800,
            height: 600,
        })

        // Load chrome://gpu
        this._gpuWindow.loadURL('chrome://gpu')

        // Open DevTools
        this._gpuWindow.webContents.openDevTools()
    }

    quit(){
        ElectronApp.quit()
    }

    restart(){
        this.quit()
        ElectronApp.relaunch()
    }
}

new Application()