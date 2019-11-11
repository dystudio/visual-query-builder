import React from 'react'
import { Paper, NativeSelect } from '@material-ui/core';
import resultsStore from './resultsStore'
import queryStore from './queryStore'
import schemaStore from './schemaStore'
import dispatcher from './dispatcher'
import { FlexTable, FlexHead, FlexBody, FlexRow, FlexCell } from './flexTable'
import Utils from './utils'


class OutputView extends React.Component {
    render(){
        return  <section id="output-view">
                    <ResultsTable></ResultsTable>
                </section>
    }
}

class ResultsTable extends React.Component {
	constructor() {
    	super()
    	this.state = {headers:[], results:[], loading:false, error:false, errorLog:"", dragging:false, filteringToggle:schemaStore.getFiltering()}
  	}

	componentWillMount(){
		//Allows this component to listen to events
        dispatcher.register(this.handleEvents.bind(this))

		resultsStore.on("results-loading", () => {
			this.setState({error:false, loading:true, results:[]})
		})
		resultsStore.on("results-fetched", () => {
			this.setState((oldState) => {
				let newState = {error:false, loading:false, results:resultsStore.getResults()}
				let newHeaders = (newState.results.length ? Object.keys(newState.results[0]) : [])

				//Only update the headers if they changed
				if(!Utils.isEqualJSON(oldState.headers, newHeaders)){
					newState.headers = newHeaders
				}
				return newState
			})
		})
		resultsStore.on("results-error", () => {
			this.setState({error:true, loading:false, errorLog:resultsStore.getErrorLog()})
		})
		schemaStore.on("filtering-toggled", () => {
			this.setState({filteringToggle:schemaStore.getFiltering()})
		})
	}

	handleEvents(ev){
        switch(ev.type){
            case "COLUMN_DRAG_START":
                this.handleDrag(true)
                break
            case "COLUMN_DRAG_END":
                this.handleDrag(false)
                break
        }
    }

   	handleDragOver(ev){
   		ev.preventDefault();
   	}


    handleDrag(isDragging){
    	this.setState({ dragging:isDragging })
    }

    handleDrop(ev){
    	const column = ev.dataTransfer.getData('column')
    	dispatcher.dispatch({ type:'COLUMN_DROP', column:column })
    }

	render(){
		const rows = (this.state.results.length ? this.state.results : []).map(r => this.state.headers.map(h => r[h]))
		const schema = schemaStore.getSchema()
		const allColumns = Object.keys(schema).reduce((arr, table) => arr.concat(schema[table]), [])
		const filterCells = this.state.headers.map(v => <FilterCell column={allColumns[allColumns.map(c => c.name).indexOf(v)]}/>)

		return  <Paper>
					{this.state.dragging && <div className="drop-curtain" onDragOver={this.handleDragOver} onDrop={(ev) => this.handleDrop(ev)}><p>Drop to Add Column to Query</p></div>}
					{this.state.loading && <Utils.AjaxLoader/>}
					{this.state.error && <p id="error-msg">{this.state.errorLog}</p>}
					{!this.state.error &&  <FlexTable>
												<FlexHead>
										        	<FlexRow cells={this.state.headers}/>
										        	{this.state.filteringToggle && <FlexRow>{filterCells}</FlexRow>}
												</FlexHead>
										        <FlexBody rows={rows}/>
									      	</FlexTable>}
				</Paper>
	}
}

class FilterCell extends React.Component {
	constructor(props) {
    	super(props)   	
    	const filter = queryStore.getWhereForColumn(this.props.column.name)
    	this.state = {operator:filter.operator.length ? filter.operator : this.props.column.type === "integer" ? "=" : "", value:filter.value }
    	this.timeout = null
    	this.delay = 1000
  	}

  	componentWillMount(){
		resultsStore.on("results-fetched", () => {
			const filter = queryStore.getWhereForColumn(this.props.column.name)
			this.setState({operator:filter.operator.length ? filter.operator : this.props.column.type === "integer" ? "=" : "", value:filter.value })
		})
	}

    handleChange(e){
        const key = e.target.name
        this.setState({ [key]: e.target.value }, () => {
        	if(this.timeout) clearInterval(this.timeout)
        	this.timeout = setTimeout(() => {

        		if(this.state.value.length || key !== "operator"){
		            dispatcher.dispatch({ 
		            	type:'FILTER_COLUMN',
		            	column:this.props.column.name,
		            	value:this.state.value,
		            	operator:this.state.operator.length ? this.state.operator : "like"
		            })        		
	        	}
        	}, this.delay)
        })
    }

	render(){
		return <FlexCell className="filter" {...this.props} >
					{this.props.column.type === "integer" && 
					<NativeSelect value={this.state.operator} onChange={(ev) => this.handleChange(ev)} inputProps={{ name: 'operator' }}>
						<option value="<" >less than</option>
						<option value="<=" >less or equal</option>
						<option value="=" selected>equal to</option>
						<option value=">=" >greater or equal</option>
						<option value=">" >greater than</option>
						<option value="<>" >not equal</option>
        			</NativeSelect>}
					<input name="value" type={this.props.column.type === "integer" ? 'number' : 'text'} placeholder={this.props.column.name + " filter"} value={this.state.value} onChange={(ev) => this.handleChange(ev)}/>
				</FlexCell>
	}
}

export default OutputView